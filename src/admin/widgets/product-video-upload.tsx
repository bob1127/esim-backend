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
} from "@medusajs/ui";
import { Trash } from "@medusajs/icons";

const MAX_VIDEO_BYTES = 15 * 1024 * 1024;
const VIDEO_MIME_TYPES = new Set([
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-m4v",
]);
const VIDEO_EXT_PATTERN = /\.(mp4|mov|webm|m4v)(\?|$)/i;

type ProductImage = {
  id?: string;
  url?: string;
};

const isVideoUrl = (url?: string) =>
  typeof url === "string" && VIDEO_EXT_PATTERN.test(url);

const ProductVideoUploadWidget = ({
  data,
}: DetailWidgetProps<Record<string, any>>) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");

  const images: ProductImage[] = data?.images || [];
  const videos = useMemo(
    () => images.filter((img) => isVideoUrl(img.url)),
    [images],
  );

  const uploadVideo = async (file: File) => {
    if (!VIDEO_MIME_TYPES.has(file.type) && !isVideoUrl(file.name)) {
      throw new Error("僅支援 MP4、MOV、WebM 影片格式。");
    }
    if (file.size > MAX_VIDEO_BYTES) {
      throw new Error("影片大小不可超過 15MB。");
    }

    const formData = new FormData();
    formData.append("files", file, file.name);

    const uploadRes = await fetch("/admin/uploads", {
      method: "POST",
      credentials: "include",
      body: formData,
    });

    if (!uploadRes.ok) {
      const err = await uploadRes.json().catch(() => ({}));
      throw new Error(err.message || "影片上傳失敗");
    }

    const uploadData = await uploadRes.json();
    const uploadedUrl = uploadData?.files?.[0]?.url;
    if (!uploadedUrl) {
      throw new Error("上傳成功但未取得影片網址");
    }

    const nextImages = [
      ...images.map((img) => ({ id: img.id, url: img.url })),
      { url: uploadedUrl },
    ];

    const updateRes = await fetch(`/admin/products/${data.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        images: nextImages,
        thumbnail: data.thumbnail || nextImages[0]?.url || null,
      }),
    });

    if (!updateRes.ok) {
      const err = await updateRes.json().catch(() => ({}));
      throw new Error(err.message || "商品媒體更新失敗");
    }
  };

  const removeVideo = async (videoUrl: string) => {
    if (!confirm("確定要移除此商品影片？")) return;

    setUploading(true);
    setError("");
    try {
      const nextImages = images
        .filter((img) => img.url !== videoUrl)
        .map((img) => ({ id: img.id, url: img.url }));

      const updateRes = await fetch(`/admin/products/${data.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          images: nextImages,
          thumbnail:
            data.thumbnail === videoUrl
              ? nextImages.find((img) => !isVideoUrl(img.url))?.url || null
              : data.thumbnail,
        }),
      });

      if (!updateRes.ok) {
        const err = await updateRes.json().catch(() => ({}));
        throw new Error(err.message || "移除影片失敗");
      }

      window.location.reload();
    } catch (err: any) {
      setError(err.message || "移除影片失敗");
    } finally {
      setUploading(false);
    }
  };

  const handleFileChange = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setUploading(true);
    setError("");
    try {
      await uploadVideo(file);
      window.location.reload();
    } catch (err: any) {
      setError(err.message || "影片上傳失敗");
    } finally {
      setUploading(false);
    }
  };

  return (
    <Container className="divide-y p-0 mt-4">
      <div className="px-6 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
          <div>
            <Heading level="h2">商品影片</Heading>
            <Text size="small" className="text-ui-fg-subtle mt-1">
              上傳商品展示影片（MP4 / MOV / WebM），單檔最大 15MB。影片會加入商品媒體，並顯示於前台畫廊。
            </Text>
          </div>
          <Badge size="small" color="grey">
            上限 15MB
          </Badge>
        </div>

        <div className="rounded-xl border border-dashed border-ui-border-base bg-ui-bg-subtle p-5">
          <Label className="mb-2 block">上傳影片</Label>
          <input
            ref={inputRef}
            type="file"
            accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm"
            className="hidden"
            onChange={handleFileChange}
            disabled={uploading}
          />
          <Button
            type="button"
            variant="secondary"
            size="small"
            disabled={uploading}
            onClick={() => inputRef.current?.click()}
          >
            {uploading ? "上傳中…" : "選擇影片檔案"}
          </Button>
          <Text size="xsmall" className="text-ui-fg-muted mt-2 block">
            內建「媒體」上傳區僅支援圖片，請在此上傳影片。
          </Text>
          {error ? (
            <Text size="small" className="text-ui-fg-error mt-3 whitespace-pre-line">
              {error}
            </Text>
          ) : null}
        </div>

        {videos.length > 0 ? (
          <div className="mt-5 space-y-3">
            <Label>已上傳影片</Label>
            {videos.map((video) => (
              <div
                key={video.id || video.url}
                className="flex flex-col sm:flex-row gap-3 rounded-lg border border-ui-border-base p-3"
              >
                <video
                  src={video.url}
                  controls
                  playsInline
                  className="w-full sm:w-56 rounded-md bg-black aspect-video object-contain"
                />
                <div className="flex-1 min-w-0">
                  <Text size="small" className="break-all text-ui-fg-subtle">
                    {video.url}
                  </Text>
                  <Button
                    type="button"
                    size="small"
                    variant="transparent"
                    className="text-ui-fg-error mt-2"
                    disabled={uploading}
                    onClick={() => video.url && removeVideo(video.url)}
                  >
                    <Trash /> 移除影片
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </Container>
  );
};

export const config = defineWidgetConfig({
  zone: "product.details.after",
});

export default ProductVideoUploadWidget;
