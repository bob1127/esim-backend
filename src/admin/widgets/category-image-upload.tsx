import React, { useState } from "react";
import { defineWidgetConfig } from "@medusajs/admin-sdk";
import {
  DetailWidgetProps,
  AdminProductCategory,
} from "@medusajs/framework/types";

async function readErrorMessage(response: Response) {
  try {
    const data = await response.json();
    return (
      data?.message ||
      data?.error ||
      data?.type ||
      JSON.stringify(data).slice(0, 200)
    );
  } catch {
    return `${response.status} ${response.statusText}`.trim();
  }
}

const CategoryImageUploadWidget = ({
  data,
}: DetailWidgetProps<AdminProductCategory>) => {
  const [uploading, setUploading] = useState(false);
  const [savingUrl, setSavingUrl] = useState(false);
  const [manualUrl, setManualUrl] = useState("");

  const currentImageUrl = (data.metadata?.image_url as string) || "";

  const saveImageUrl = async (imageUrl: string) => {
    const response = await fetch(`/admin/product-categories/${data.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        metadata: {
          ...(data.metadata || {}),
          image_url: imageUrl,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Medusa 更新分類失敗：${await readErrorMessage(response)}`,
      );
    }
  };

  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.target;
    try {
      const file = input.files?.[0];
      if (!file) return;
      setUploading(true);

      const formData = new FormData();
      formData.append("files", file);

      const uploadRes = await fetch("/admin/uploads", {
        method: "POST",
        credentials: "include",
        body: formData,
      });

      if (!uploadRes.ok) {
        throw new Error(
          `圖片上傳失敗：${await readErrorMessage(uploadRes)}`,
        );
      }

      const uploaded = await uploadRes.json();
      const publicUrl =
        uploaded?.files?.[0]?.url ||
        uploaded?.uploads?.[0]?.url ||
        uploaded?.url;

      if (!publicUrl) {
        throw new Error("上傳成功但沒有回傳圖片網址");
      }

      await saveImageUrl(publicUrl);
      window.location.reload();
    } catch (error: any) {
      const message =
        error?.message === "Failed to fetch"
          ? "無法連線上傳服務（Failed to fetch）。請確認 Medusa 後台仍在跑，並改走本機 /admin/uploads。"
          : error?.message || "上傳失敗";
      alert(`發生錯誤: ${message}`);
    } finally {
      setUploading(false);
      input.value = "";
    }
  };

  const handleSaveManualUrl = async () => {
    const imageUrl = manualUrl.trim();
    if (!imageUrl) return;
    try {
      setSavingUrl(true);
      await saveImageUrl(imageUrl);
      window.location.reload();
    } catch (error: any) {
      alert(`發生錯誤: ${error?.message || "儲存網址失敗"}`);
    } finally {
      setSavingUrl(false);
    }
  };

  const busy = uploading || savingUrl;

  return (
    <div className="bg-white p-8 border border-gray-200 rounded-lg mt-4 shadow-sm">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-xl font-bold text-gray-900">分類視覺圖</h2>
          <p className="text-sm text-gray-500 mt-1">
            此圖片將直接對接前台 eSIM 商店顯示。
          </p>
        </div>
        {busy && (
          <div className="flex items-center gap-2 text-blue-600 font-medium text-sm animate-pulse">
            <span className="w-2 h-2 bg-blue-600 rounded-full"></span>
            正在處理中...
          </div>
        )}
      </div>

      <div className="flex items-start gap-8">
        <div className="w-48 h-48 bg-gray-50 border-2 border-dashed border-gray-200 rounded-xl flex items-center justify-center overflow-hidden relative group">
          {currentImageUrl ? (
            <>
              <img
                src={currentImageUrl}
                alt="分類縮圖"
                className="w-full h-full object-cover"
              />
              <div className="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-10 transition-all"></div>
            </>
          ) : (
            <div className="text-center p-4">
              <span className="text-3xl mb-2 block">🖼️</span>
              <p className="text-xs text-gray-400">尚未上傳圖片</p>
            </div>
          )}
        </div>

        <div className="flex-1 space-y-4">
          <div className="bg-gray-50 p-6 rounded-lg border border-gray-100">
            <label className="block text-sm font-medium text-stone-900 mb-2">
              更新圖片
            </label>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/*"
              onChange={handleUpload}
              disabled={busy}
              className="block w-full text-sm text-gray-500 file:mr-4 file:py-2.5 file:px-6 file:rounded-lg file:border-0 file:text-sm file:font-bold file:bg-blue-600 file:text-white hover:file:bg-blue-700 cursor-pointer disabled:opacity-50"
            />
          </div>
          <div className="bg-gray-50 p-6 rounded-lg border border-gray-100">
            <label className="block text-sm font-medium text-stone-900 mb-2">
              或填入圖片網址
            </label>
            <div className="flex gap-2">
              <input
                type="url"
                value={manualUrl}
                onChange={(e) => setManualUrl(e.target.value)}
                placeholder="/images/分類eSIM-泰國.png"
                disabled={busy}
                className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm"
              />
              <button
                type="button"
                onClick={handleSaveManualUrl}
                disabled={busy || !manualUrl.trim()}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
              >
                儲存
              </button>
            </div>
          </div>
          <p className="text-xs text-gray-400 italic">
            支援格式：PNG, JPG, WebP。建議尺寸：800x800px。圖片會上傳到 Medusa
            本機檔案，不再經過 Supabase Storage。
          </p>
        </div>
      </div>
    </div>
  );
};

export const config = defineWidgetConfig({
  zone: "product_category.details.after",
});

export default CategoryImageUploadWidget;
