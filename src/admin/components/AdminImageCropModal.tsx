/**
 * Admin 固定比例裁切（拖曳／縮放 → 高品質 JPEG）
 * 保留裁切區解析度，不以大幅降 JPEG quality 換檔案大小。
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Button, Heading, Text } from "@medusajs/ui";

export const PHYSICAL_DESC_ASPECT = {
  "4:3": 4 / 3,
  "3:4": 3 / 4,
} as const;

export type PhysicalDescAspectKey = keyof typeof PHYSICAL_DESC_ASPECT;

/** 與上傳來源上限對齊；優先保畫質，不以降 JPEG 品質換檔案大小 */
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
/** 瀏覽器 canvas 實務上限；不再為壓縮而砍到 2000 */
const MAX_EDGE = 4096;
/** 幾乎無損的 JPEG 品質（不再往下壓到 0.45） */
const JPEG_QUALITY = 0.97;

function coverMetrics(
  nw: number,
  nh: number,
  cw: number,
  ch: number,
  zoom: number,
) {
  const cover = Math.max(cw / nw, ch / nh);
  const scale = cover * zoom;
  return { scale, dispW: nw * scale, dispH: nh * scale };
}

async function canvasToJpegBlob(
  canvas: HTMLCanvasElement,
  quality: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("輸出失敗"))),
      "image/jpeg",
      quality,
    );
  });
}

function drawCropToCanvas(
  image: HTMLImageElement,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  outW: number,
  outH: number,
) {
  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("無法建立畫布");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, sx, sy, sw, sh, 0, 0, outW, outH);
  return canvas;
}

async function exportCroppedBlob({
  image,
  containerW,
  containerH,
  offset,
  zoom,
  aspect,
}: {
  image: HTMLImageElement;
  containerW: number;
  containerH: number;
  offset: { x: number; y: number };
  zoom: number;
  aspect: number;
}) {
  const nw = image.naturalWidth;
  const nh = image.naturalHeight;
  if (!nw || !nh || !containerW || !containerH) {
    throw new Error("圖片尚未載入完成");
  }

  const { scale, dispW, dispH } = coverMetrics(
    nw,
    nh,
    containerW,
    containerH,
    zoom,
  );
  const left = (containerW - dispW) / 2 + offset.x;
  const top = (containerH - dispH) / 2 + offset.y;

  const sx = Math.max(0, Math.min(nw, -left / scale));
  const sy = Math.max(0, Math.min(nh, -top / scale));
  const sw = Math.max(1, Math.min(nw - sx, containerW / scale));
  const sh = Math.max(1, Math.min(nh - sy, containerH / scale));

  // 預設保留裁切區原始解析度（不再強制壓到 2000）
  let outW = sw;
  let outH = sh;
  const long = Math.max(outW, outH);
  if (long > MAX_EDGE) {
    const r = MAX_EDGE / long;
    outW *= r;
    outH *= r;
  }
  outW = Math.max(1, Math.round(outW));
  outH = Math.max(1, Math.round(outW / aspect));

  let canvas = drawCropToCanvas(image, sx, sy, sw, sh, outW, outH);
  let blob = await canvasToJpegBlob(canvas, JPEG_QUALITY);

  // 檔案過大時只微縮尺寸，維持高畫質，不降 JPEG quality
  let guard = 0;
  while (blob.size > MAX_UPLOAD_BYTES && Math.max(outW, outH) > 1200 && guard < 8) {
    guard += 1;
    const r = 0.85;
    outW = Math.max(1, Math.round(outW * r));
    outH = Math.max(1, Math.round(outW / aspect));
    canvas = drawCropToCanvas(image, sx, sy, sw, sh, outW, outH);
    blob = await canvasToJpegBlob(canvas, JPEG_QUALITY);
  }
  if (blob.size > MAX_UPLOAD_BYTES) {
    throw new Error("裁切後檔案仍過大，請換較小原圖");
  }
  return blob;
}

type Props = {
  file: File;
  aspectKey: PhysicalDescAspectKey;
  onCancel: () => void;
  onConfirm: (file: File) => Promise<void> | void;
};

export default function AdminImageCropModal({
  file,
  aspectKey,
  onCancel,
  onConfirm,
}: Props) {
  const aspect = PHYSICAL_DESC_ASPECT[aspectKey] || PHYSICAL_DESC_ASPECT["4:3"];
  const [src, setSrc] = useState("");
  const [ready, setReady] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [layout, setLayout] = useState({
    w: 0,
    h: 0,
    dispW: 0,
    dispH: 0,
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const imgRef = useRef<HTMLImageElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    x: number;
    y: number;
    ox: number;
    oy: number;
  } | null>(null);

  const refreshLayout = useCallback(
    (z = zoom, o = offset) => {
      const img = imgRef.current;
      const box = boxRef.current;
      if (!img?.naturalWidth || !box) return;
      const cw = box.clientWidth;
      const ch = box.clientHeight;
      const { dispW, dispH } = coverMetrics(
        img.naturalWidth,
        img.naturalHeight,
        cw,
        ch,
        z,
      );
      const maxX = Math.max(0, (dispW - cw) / 2);
      const maxY = Math.max(0, (dispH - ch) / 2);
      const clamped = {
        x: Math.min(maxX, Math.max(-maxX, o.x)),
        y: Math.min(maxY, Math.max(-maxY, o.y)),
      };
      if (clamped.x !== o.x || clamped.y !== o.y) setOffset(clamped);
      setLayout({ w: cw, h: ch, dispW, dispH });
    },
    [zoom, offset],
  );

  useEffect(() => {
    const url = URL.createObjectURL(file);
    setSrc(url);
    setReady(false);
    setZoom(1);
    setOffset({ x: 0, y: 0 });
    setErr("");
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    if (!ready) return;
    refreshLayout(zoom, offset);
    const onResize = () => refreshLayout(zoom, offset);
    window.addEventListener("resize", onResize);
    const box = boxRef.current;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setZoom((z) =>
        Math.min(3, Math.max(1, z + (e.deltaY < 0 ? 0.08 : -0.08))),
      );
    };
    box?.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      window.removeEventListener("resize", onResize);
      box?.removeEventListener("wheel", onWheel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, zoom]);

  const left = layout.w ? (layout.w - layout.dispW) / 2 + offset.x : 0;
  const top = layout.h ? (layout.h - layout.dispH) / 2 + offset.y : 0;

  const handleConfirm = async () => {
    const img = imgRef.current;
    const box = boxRef.current;
    if (!img || !box) return;
    setBusy(true);
    setErr("");
    try {
      const blob = await exportCroppedBlob({
        image: img,
        containerW: box.clientWidth,
        containerH: box.clientHeight,
        offset,
        zoom,
        aspect,
      });
      const out = new File(
        [blob],
        `${(file.name || "image").replace(/\.\w+$/, "")}-crop.jpg`,
        { type: "image/jpeg" },
      );
      await onConfirm(out);
    } catch (e: any) {
      setErr(e?.message || "裁切失敗");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <button
        type="button"
        aria-label="關閉"
        onClick={busy ? undefined : onCancel}
        style={{
          position: "absolute",
          inset: 0,
          background: "rgba(0,0,0,0.55)",
          border: "none",
          cursor: busy ? "default" : "pointer",
        }}
      />
      <div
        style={{
          position: "relative",
          width: "100%",
          maxWidth: 480,
          background: "#fff",
          borderRadius: 12,
          overflow: "hidden",
          boxShadow: "0 20px 50px rgba(0,0,0,0.25)",
        }}
      >
        <div
          style={{
            padding: "12px 16px",
            borderBottom: "1px solid #e5e7eb",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div>
            <Heading level="h2">裁切圖片</Heading>
            <Text size="small" className="text-ui-fg-subtle">
              比例 {aspectKey}・拖曳移動・滾輪／滑桿縮放
            </Text>
          </div>
          <Button
            type="button"
            size="small"
            variant="transparent"
            disabled={busy}
            onClick={onCancel}
          >
            取消
          </Button>
        </div>

        <div style={{ padding: 16 }}>
          <div
            ref={boxRef}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture?.(e.pointerId);
              dragRef.current = {
                x: e.clientX,
                y: e.clientY,
                ox: offset.x,
                oy: offset.y,
              };
            }}
            onPointerMove={(e) => {
              if (!dragRef.current) return;
              const next = {
                x: dragRef.current.ox + (e.clientX - dragRef.current.x),
                y: dragRef.current.oy + (e.clientY - dragRef.current.y),
              };
              setOffset(next);
              refreshLayout(zoom, next);
            }}
            onPointerUp={() => {
              dragRef.current = null;
            }}
            style={{
              width: "100%",
              aspectRatio: String(aspect),
              background: "#111",
              overflow: "hidden",
              position: "relative",
              touchAction: "none",
              cursor: "grab",
              borderRadius: 8,
            }}
          >
            {src ? (
              // eslint-disable-next-line jsx-a11y/alt-text
              <img
                ref={imgRef}
                src={src}
                draggable={false}
                onLoad={() => {
                  setReady(true);
                  requestAnimationFrame(() => refreshLayout(1, { x: 0, y: 0 }));
                }}
                style={{
                  position: "absolute",
                  width: layout.dispW || "100%",
                  height: layout.dispH || "auto",
                  left,
                  top,
                  maxWidth: "none",
                  userSelect: "none",
                  pointerEvents: "none",
                }}
              />
            ) : null}
          </div>

          <div style={{ marginTop: 12 }}>
            <Text size="small" className="text-ui-fg-subtle mb-1 block">
              縮放
            </Text>
            <input
              type="range"
              min={1}
              max={3}
              step={0.01}
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
              style={{ width: "100%" }}
            />
          </div>

          {err ? (
            <Text size="small" className="text-ui-fg-error mt-2 block">
              {err}
            </Text>
          ) : null}

          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: 8,
              marginTop: 16,
            }}
          >
            <Button
              type="button"
              variant="secondary"
              size="small"
              disabled={busy}
              onClick={onCancel}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="primary"
              size="small"
              isLoading={busy}
              disabled={!ready || busy}
              onClick={handleConfirm}
            >
              確認裁切並上傳
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
