import React, { useMemo, useRef, useState } from "react";
import { defineWidgetConfig } from "@medusajs/admin-sdk";
import { DetailWidgetProps } from "@medusajs/framework/types";
import {
  Badge,
  Button,
  Container,
  Heading,
  Label,
  Text,
  Textarea,
} from "@medusajs/ui";
import { Trash } from "@medusajs/icons";
import { useIsPhysicalProduct } from "../lib/useIsPhysicalProduct";
import AdminImageCropModal, {
  PHYSICAL_DESC_ASPECT,
  type PhysicalDescAspectKey,
} from "../components/AdminImageCropModal";

const METADATA_KEY = "physical_description";
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

type DescImage = { url: string; alt?: string };

type PhysicalDescription = {
  text: string;
  aspect: PhysicalDescAspectKey;
  images: DescImage[];
};

function parseDescription(
  metadata?: Record<string, unknown> | null,
): PhysicalDescription {
  const raw = metadata?.[METADATA_KEY];
  let obj: any = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      obj = null;
    }
  }
  const aspect: PhysicalDescAspectKey =
    obj?.aspect === "3:4" ? "3:4" : "4:3";
  const images = Array.isArray(obj?.images)
    ? obj.images
        .map((img: any) => ({
          url: String(img?.url || "").trim(),
          alt: String(img?.alt || "").trim(),
        }))
        .filter((img: DescImage) => img.url)
    : [];
  return {
    text: String(obj?.text || ""),
    aspect,
    images,
  };
}

const ProductPhysicalDescriptionInner = ({
  data,
}: DetailWidgetProps<Record<string, any>>) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const initial = useMemo(
    () => parseDescription(data.metadata),
    [data.metadata],
  );
  const [text, setText] = useState(initial.text);
  const [aspect, setAspect] = useState<PhysicalDescAspectKey>(initial.aspect);
  const [images, setImages] = useState<DescImage[]>(initial.images);
  const [cropFile, setCropFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const aspectRatio = PHYSICAL_DESC_ASPECT[aspect];

  const persist = async (next: PhysicalDescription) => {
    const payload = {
      text: next.text.trim(),
      aspect: next.aspect,
      images: next.images,
    };
    const res = await fetch(`/admin/products/${data.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        metadata: {
          ...(data.metadata || {}),
          [METADATA_KEY]: JSON.stringify(payload),
        },
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || err.type || "儲存失敗");
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError("");
    setMessage("");
    try {
      await persist({ text, aspect, images });
      setDirty(false);
      setMessage("產品說明已儲存");
    } catch (e: any) {
      setError(e?.message || "儲存失敗");
    } finally {
      setSaving(false);
    }
  };

  const onPickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!/^image\/(jpeg|jpg|png|webp)$/i.test(file.type)) {
      setError("僅支援 JPG／PNG／WebP");
      return;
    }
    if (file.size > MAX_SOURCE_BYTES) {
      setError("原圖不可超過 8MB");
      return;
    }
    setError("");
    setCropFile(file);
  };

  const uploadCropped = async (file: File) => {
    setUploading(true);
    setError("");
    try {
      const formData = new FormData();
      formData.append("files", file, file.name);
      const uploadRes = await fetch("/admin/uploads", {
        method: "POST",
        credentials: "include",
        body: formData,
      });
      if (!uploadRes.ok) {
        const err = await uploadRes.json().catch(() => ({}));
        throw new Error(err.message || "上傳失敗");
      }
      const uploadData = await uploadRes.json();
      const url = uploadData?.files?.[0]?.url;
      if (!url) throw new Error("上傳成功但未取得網址");

      const nextImages = [...images, { url, alt: "" }];
      setImages(nextImages);
      setCropFile(null);
      // 上傳後一併寫入，避免只加圖忘記按儲存
      await persist({ text, aspect, images: nextImages });
      setDirty(false);
      setMessage("圖片已上傳並儲存");
    } catch (e: any) {
      setError(e?.message || "上傳失敗");
    } finally {
      setUploading(false);
    }
  };

  const removeImage = async (url: string) => {
    if (!confirm("確定移除此說明圖？")) return;
    const nextImages = images.filter((img) => img.url !== url);
    setImages(nextImages);
    setDirty(true);
    try {
      await persist({ text, aspect, images: nextImages });
      setDirty(false);
      setMessage("已移除圖片");
    } catch (e: any) {
      setError(e?.message || "移除失敗");
    }
  };

  const moveImage = (index: number, dir: -1 | 1) => {
    const next = index + dir;
    if (next < 0 || next >= images.length) return;
    const copy = [...images];
    const tmp = copy[index];
    copy[index] = copy[next];
    copy[next] = tmp;
    setImages(copy);
    setDirty(true);
  };

  return (
    <Container className="divide-y p-0 mt-4">
      <div className="px-6 py-4 space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <Heading level="h2">產品說明（實體商品）</Heading>
            <Text size="small" className="text-ui-fg-subtle mt-1">
              文字說明＋圖片列表。前台電腦兩欄、手機一欄；上傳時依選定比例裁切。
            </Text>
          </div>
          <div className="flex items-center gap-2">
            {dirty ? (
              <Badge size="small" color="orange">
                尚未儲存
              </Badge>
            ) : null}
            <Button
              type="button"
              size="small"
              variant="primary"
              isLoading={saving}
              disabled={saving || uploading}
              onClick={handleSave}
            >
              儲存說明
            </Button>
          </div>
        </div>

        <div>
          <Label className="mb-1.5 block">1. 產品文字說明</Label>
          <Textarea
            rows={5}
            placeholder="介紹材質、用途、規格重點…"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setDirty(true);
            }}
          />
        </div>

        <div>
          <Label className="mb-1.5 block">圖片比例</Label>
          <div className="flex flex-wrap gap-2">
            {(["4:3", "3:4"] as PhysicalDescAspectKey[]).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => {
                  setAspect(key);
                  setDirty(true);
                }}
                className={`px-3 py-1.5 text-sm rounded-md border ${
                  aspect === key
                    ? "border-ui-fg-interactive bg-ui-bg-interactive text-ui-fg-on-color"
                    : "border-ui-border-base bg-ui-bg-base text-ui-fg-base"
                }`}
              >
                {key}
              </button>
            ))}
          </div>
          <Text size="xsmall" className="text-ui-fg-muted mt-1.5 block">
            變更比例只影響之後新上傳的裁切框；已上傳圖片不會自動重裁。
          </Text>
        </div>

        <div>
          <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
            <Label className="block">2. 圖片列表</Label>
            <Badge size="2xsmall" color="grey">
              桌機兩欄／手機一欄
            </Badge>
          </div>

          <input
            ref={inputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
            className="hidden"
            onChange={onPickFile}
            disabled={uploading}
          />
          <div className="rounded-xl border border-dashed border-ui-border-base bg-ui-bg-subtle p-4 mb-4">
            <Button
              type="button"
              size="small"
              variant="secondary"
              disabled={uploading}
              isLoading={uploading}
              onClick={() => inputRef.current?.click()}
            >
              {uploading ? "上傳中…" : "上傳並裁切圖片"}
            </Button>
            <Text size="xsmall" className="text-ui-fg-muted mt-2 block">
              支援 JPG／PNG／WebP，原圖上限 8MB；裁切後約 2MB 內。
            </Text>
          </div>

          {images.length === 0 ? (
            <Text size="small" className="text-ui-fg-subtle">
              尚未新增說明圖。
            </Text>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {images.map((img, index) => (
                <div
                  key={`${img.url}-${index}`}
                  className="rounded-lg border border-ui-border-base overflow-hidden bg-ui-bg-base"
                >
                  <div
                    className="relative w-full bg-ui-bg-subtle overflow-hidden"
                    style={{ aspectRatio: String(aspectRatio) }}
                  >
                    <img
                      src={img.url}
                      alt={img.alt || `說明圖 ${index + 1}`}
                      className="absolute inset-0 w-full h-full object-cover"
                    />
                  </div>
                  <div className="p-2 flex flex-wrap gap-1">
                    <Button
                      type="button"
                      size="small"
                      variant="secondary"
                      disabled={index === 0}
                      onClick={() => moveImage(index, -1)}
                    >
                      上移
                    </Button>
                    <Button
                      type="button"
                      size="small"
                      variant="secondary"
                      disabled={index === images.length - 1}
                      onClick={() => moveImage(index, 1)}
                    >
                      下移
                    </Button>
                    <Button
                      type="button"
                      size="small"
                      variant="transparent"
                      className="text-ui-fg-error"
                      onClick={() => removeImage(img.url)}
                    >
                      <Trash /> 移除
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {message ? (
          <Text size="small" className="text-ui-fg-interactive">
            {message}
          </Text>
        ) : null}
        {error ? (
          <Text size="small" className="text-ui-fg-error whitespace-pre-line">
            {error}
          </Text>
        ) : null}
      </div>

      {cropFile ? (
        <AdminImageCropModal
          file={cropFile}
          aspectKey={aspect}
          onCancel={() => setCropFile(null)}
          onConfirm={uploadCropped}
        />
      ) : null}
    </Container>
  );
};

const ProductPhysicalDescriptionWidget = (
  props: DetailWidgetProps<Record<string, any>>,
) => {
  const isPhysical = useIsPhysicalProduct(props.data);
  if (!isPhysical) return null;
  return <ProductPhysicalDescriptionInner {...props} />;
};

export const config = defineWidgetConfig({
  zone: "product.details.after",
});

export default ProductPhysicalDescriptionWidget;
