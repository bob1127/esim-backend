import React, { useMemo, useState } from "react";
import { defineWidgetConfig } from "@medusajs/admin-sdk";
import {
  DetailWidgetProps,
  AdminProductCategory,
} from "@medusajs/framework/types";

type PromoDraft = {
  enabled: boolean;
  badge: string;
  title: string;
  description: string;
  discount_code: string;
  cta_label: string;
  cta_href: string;
};

function readMeta(data: AdminProductCategory): PromoDraft {
  const m = (data.metadata || {}) as Record<string, unknown>;
  return {
    enabled: Boolean(m.promo_enabled ?? false),
    badge: String(m.promo_badge || "獨家優惠"),
    title: String(m.promo_title || ""),
    description: String(m.promo_description || ""),
    discount_code: String(m.promo_discount_code || "").toUpperCase(),
    cta_label: String(m.promo_cta_label || "立即前往購買"),
    cta_href: String(m.promo_cta_href || ""),
  };
}

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

/**
 * 國家分類促銷卡：標題／說明／折扣碼（前台分類頁、部落格側欄可讀 metadata）
 */
const CategoryPromoBannerWidget = ({
  data,
}: DetailWidgetProps<AdminProductCategory>) => {
  const initial = useMemo(() => readMeta(data), [data]);
  const [draft, setDraft] = useState<PromoDraft>(initial);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  const defaultHref = data.handle
    ? `/product/${String(data.handle).replace(/^\/+|\/+$/g, "")}`
    : "/product";

  const update = <K extends keyof PromoDraft>(key: K, value: PromoDraft[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setMessage("");
  };

  const save = async () => {
    setSaving(true);
    setMessage("");
    try {
      const code = draft.discount_code.trim().toUpperCase();
      const response = await fetch(`/admin/product-categories/${data.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          metadata: {
            ...(data.metadata || {}),
            promo_enabled: draft.enabled,
            promo_badge: draft.badge.trim() || "獨家優惠",
            promo_title: draft.title.trim(),
            promo_description: draft.description.trim(),
            promo_discount_code: code,
            promo_cta_label: draft.cta_label.trim() || "立即前往購買",
            promo_cta_href: draft.cta_href.trim() || defaultHref,
          },
        }),
      });

      if (!response.ok) {
        throw new Error(
          `儲存失敗：${await readErrorMessage(response)}`,
        );
      }

      setMessage("已儲存分類促銷設定");
      window.setTimeout(() => window.location.reload(), 600);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "儲存失敗";
      alert(msg);
      setMessage(msg);
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    if (!window.confirm("確定清除此分類的促銷卡設定？")) return;
    setSaving(true);
    try {
      const response = await fetch(`/admin/product-categories/${data.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          metadata: {
            ...(data.metadata || {}),
            promo_enabled: false,
            promo_badge: "",
            promo_title: "",
            promo_description: "",
            promo_discount_code: "",
            promo_cta_label: "",
            promo_cta_href: "",
          },
        }),
      });
      if (!response.ok) {
        throw new Error(
          `清除失敗：${await readErrorMessage(response)}`,
        );
      }
      window.location.reload();
    } catch (error: unknown) {
      alert(error instanceof Error ? error.message : "清除失敗");
    } finally {
      setSaving(false);
    }
  };

  const inputClass =
    "mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500/30";

  return (
    <div className="bg-white p-8 border border-gray-200 rounded-lg mt-4 shadow-sm">
      <div className="flex justify-between items-start gap-4 mb-6">
        <div>
          <h2 className="text-xl font-bold text-gray-900">分類促銷卡</h2>
          <p className="text-sm text-gray-500 mt-1">
            設定此國家分類的標題、說明與折扣碼（例：日本 eSIM 吃到飽／WMESIM2026）。
            前台分類頁與文章側欄可顯示；實際折抵仍須在 Medusa「促銷／折扣碼」建立同名活動。
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm font-medium text-gray-800 shrink-0">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => update("enabled", e.target.checked)}
            className="h-4 w-4 rounded border-gray-300"
          />
          啟用顯示
        </label>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-800">
            標籤（小紅章）
          </label>
          <input
            className={inputClass}
            value={draft.badge}
            onChange={(e) => update("badge", e.target.value)}
            placeholder="獨家優惠"
            disabled={saving}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-800">
            折扣碼
          </label>
          <input
            className={`${inputClass} font-mono tracking-wider uppercase`}
            value={draft.discount_code}
            onChange={(e) => update("discount_code", e.target.value)}
            placeholder="WMESIM2026"
            disabled={saving}
          />
        </div>
        <div className="md:col-span-2">
          <label className="block text-sm font-medium text-gray-800">
            標題
          </label>
          <input
            className={inputClass}
            value={draft.title}
            onChange={(e) => update("title", e.target.value)}
            placeholder="日本 eSIM 吃到飽方案"
            disabled={saving}
          />
        </div>
        <div className="md:col-span-2">
          <label className="block text-sm font-medium text-gray-800">
            說明文案
          </label>
          <textarea
            className={`${inputClass} min-h-[88px] resize-y`}
            value={draft.description}
            onChange={(e) => update("description", e.target.value)}
            placeholder="輸入折扣碼即享 9 折優惠，免換卡掃碼即用，打卡找路不斷線！"
            disabled={saving}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-800">
            按鈕文字
          </label>
          <input
            className={inputClass}
            value={draft.cta_label}
            onChange={(e) => update("cta_label", e.target.value)}
            placeholder="立即前往購買"
            disabled={saving}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-800">
            按鈕連結
          </label>
          <input
            className={inputClass}
            value={draft.cta_href}
            onChange={(e) => update("cta_href", e.target.value)}
            placeholder={defaultHref}
            disabled={saving}
          />
          <p className="mt-1 text-xs text-gray-400">
            空白則預設 {defaultHref}
          </p>
        </div>
      </div>

      {(draft.title || draft.discount_code) && (
        <div className="mt-6 rounded-lg bg-gradient-to-br from-[#111] to-[#333] text-white p-5 max-w-md">
          <span className="bg-[#ff4757] text-white text-[11px] font-bold px-3 py-1 rounded-sm tracking-wider uppercase mb-3 inline-block">
            {draft.badge || "獨家優惠"}
          </span>
          <h4 className="text-[18px] font-bold mb-2 tracking-wide">
            {draft.title || "（標題）"}
          </h4>
          <p className="text-[13px] text-white/80 mb-4 leading-relaxed">
            {draft.description || "（說明文案）"}
          </p>
          {draft.discount_code ? (
            <div className="bg-black/50 border border-white/20 rounded px-3 py-2 text-center font-mono text-sm tracking-widest">
              {draft.discount_code}
            </div>
          ) : null}
        </div>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-bold text-white disabled:opacity-50 hover:bg-blue-700"
        >
          {saving ? "儲存中…" : "儲存促銷卡"}
        </button>
        <button
          type="button"
          onClick={clear}
          disabled={saving}
          className="rounded-lg border border-gray-200 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 disabled:opacity-50 hover:bg-gray-50"
        >
          清除
        </button>
        {message ? (
          <span className="text-sm text-gray-600">{message}</span>
        ) : null}
      </div>
    </div>
  );
};

export const config = defineWidgetConfig({
  zone: "product_category.details.after",
});

export default CategoryPromoBannerWidget;
