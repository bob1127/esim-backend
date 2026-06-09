import React, { useState } from "react";
import { defineWidgetConfig } from "@medusajs/admin-sdk";
import {
  DetailWidgetProps,
  AdminProductCategory,
} from "@medusajs/framework/types";
import { createClient } from "@supabase/supabase-js";

// 🚀 初始化 Supabase
const supabase = createClient(
  "https://ppxaexmahiwmabkiwoct.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBweGFleG1haGl3bWFia2l3b2N0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1ODg3OTcsImV4cCI6MjA5MjE2NDc5N30.RQ_scSU6AQdOXLLxSxyrTa0edLkmJ2XldUdv6KYM32Q",
);

const CategoryImageUploadWidget = ({
  data,
}: DetailWidgetProps<AdminProductCategory>) => {
  const [uploading, setUploading] = useState(false);

  const currentImageUrl = (data.metadata?.image_url as string) || "";

  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    try {
      const file = event.target.files?.[0];
      if (!file) return;
      setUploading(true);

      // 1. 上傳至 Supabase Storage
      const fileExt = file.name.split(".").pop();
      const fileName = `cat_${data.id}_${Date.now()}.${fileExt}`;
      const { error: uploadError } = await supabase.storage
        .from("project-image")
        .upload(fileName, file);

      if (uploadError) throw uploadError;

      // 2. 獲取公開網址
      const {
        data: { publicUrl },
      } = supabase.storage.from("project-image").getPublicUrl(fileName);

      // 3. 🚀 呼叫 Medusa API (加上管理員通行證 credentials)
      const response = await fetch(`/admin/product-categories/${data.id}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include", // 👈 就是加了這一行！讓 API 知道你是管理員
        body: JSON.stringify({
          metadata: {
            ...data.metadata,
            image_url: publicUrl,
          },
        }),
      });

      // 4. 嚴格的錯誤檢查，印出真正的失敗原因
      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        console.error("Medusa 拒絕更新:", errData);
        throw new Error(
          errData.message || errData.type || "Medusa 資料庫拒絕更新",
        );
      }

      // 5. 完成後刷新頁面
      window.location.reload();
    } catch (error: any) {
      alert(`發生錯誤: ${error.message}`);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="bg-white p-8 border border-gray-200 rounded-lg mt-4 shadow-sm">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-xl font-bold text-gray-900">分類視覺圖</h2>
          <p className="text-sm text-gray-500 mt-1">
            此圖片將直接對接前台 eSIM 商店顯示。
          </p>
        </div>
        {uploading && (
          <div className="flex items-center gap-2 text-blue-600 font-medium text-sm animate-pulse">
            <span className="w-2 h-2 bg-blue-600 rounded-full"></span>{" "}
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
            <label className="block text-sm font-medium text-gray-700 mb-2">
              更新圖片
            </label>
            <input
              type="file"
              accept="image/*"
              onChange={handleUpload}
              disabled={uploading}
              className="block w-full text-sm text-gray-500 file:mr-4 file:py-2.5 file:px-6 file:rounded-lg file:border-0 file:text-sm file:font-bold file:bg-blue-600 file:text-white hover:file:bg-blue-700 cursor-pointer disabled:opacity-50"
            />
          </div>
          <p className="text-xs text-gray-400 italic">
            支援格式：PNG, JPG, WebP。建議尺寸：800x800px。
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
