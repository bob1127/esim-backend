import React, { useCallback, useMemo, useRef, useState } from "react";
import { defineWidgetConfig } from "@medusajs/admin-sdk";
import { DetailWidgetProps } from "@medusajs/framework/types";
import {
  Badge,
  Button,
  Container,
  Heading,
  Input,
  Label,
  ProgressAccordion,
  Text,
} from "@medusajs/ui";
import { PlusMini, Trash } from "@medusajs/icons";

type CarrierFeaturesMap = Record<string, string[]>;

const METADATA_KEY = "key_features_by_carrier";

const parseCarrierFeatures = (
  metadata?: Record<string, unknown> | null,
): CarrierFeaturesMap => {
  const raw = metadata?.[METADATA_KEY];
  if (!raw) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return Object.fromEntries(
      Object.entries(raw as Record<string, unknown>).map(([k, v]) => [
        k,
        Array.isArray(v) ? v.map(String) : [],
      ]),
    );
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return Object.fromEntries(
          Object.entries(parsed).map(([k, v]) => [
            k,
            Array.isArray(v) ? v.map(String) : [],
          ]),
        );
      }
    } catch {
      /* ignore */
    }
  }
  return {};
};

const isTelecomValue = (value: string) => {
  if (!value) return false;
  if (/天|Days/i.test(value)) return false;
  if (/流量|GB|MB|吃到飽/i.test(value)) return false;
  return true;
};

const extractTelecomCarriers = (product: Record<string, any>): string[] => {
  const set = new Set<string>();

  // 優先：Product Option 標題含電信／carrier 關鍵字
  product?.options?.forEach((option: any) => {
    const title = String(option?.title ?? "").toLowerCase();
    if (
      title.includes("telecom") ||
      title.includes("電信") ||
      title.includes("carrier") ||
      title.includes("operator") ||
      title.includes("網路")
    ) {
      option?.values?.forEach((v: any) => {
        const val = String(v?.value ?? v ?? "").trim();
        if (val) set.add(val);
      });
    }
  });

  // 其次：從各變體選項值推斷（排除天數、流量）
  product?.variants?.forEach((variant: any) => {
    variant?.options?.forEach((opt: any) => {
      const val = String(opt?.value ?? "").trim();
      if (isTelecomValue(val)) set.add(val);
    });
  });

  return [...set];
};

const mergeCarrierMaps = (
  saved: CarrierFeaturesMap,
  carriers: string[],
): CarrierFeaturesMap => {
  const keys = new Set([...Object.keys(saved), ...carriers]);
  const merged: CarrierFeaturesMap = {};
  keys.forEach((key) => {
    merged[key] = saved[key]?.length ? [...saved[key]] : [""];
  });
  return merged;
};

const sanitizeForSave = (map: CarrierFeaturesMap): CarrierFeaturesMap => {
  const out: CarrierFeaturesMap = {};
  Object.entries(map).forEach(([carrier, bullets]) => {
    const cleaned = bullets
      .map((b) => b.replace(/^\s+|\s+$/g, ""))
      .filter(Boolean);
    if (cleaned.length) out[carrier] = cleaned;
  });
  return out;
};

/** 與前台相同的分段 + 連結預覽 */
const previewFeatureHtml = (text: string) => {
  if (!text.trim()) return "";
  const linkClass = "text-[#0066cc] underline";

  const applyLinks = (segment: string) => {
    const escaped = segment
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    return escaped.replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      (_, label, href) =>
        `<a href="${String(href).trim()}" class="${linkClass}" target="_blank" rel="noopener">${label}</a>`,
    );
  };

  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((paragraph) => {
      const lines = paragraph
        .split("\n")
        .map((line) => applyLinks(line.trim()))
        .filter(Boolean);
      return `<p style="margin:0 0 0.5rem;line-height:1.6">${lines.join("<br>")}</p>`;
    })
    .join("");
};

/** 單段重點特色：正文 + 分段 + 插入連結 + 預覽 */
function FeatureBulletRow({
  value,
  index,
  onChange,
  onRemove,
}: {
  value: string;
  index: number;
  onChange: (value: string) => void;
  onRemove: () => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [linkLabel, setLinkLabel] = useState("");
  const [linkHref, setLinkHref] = useState("");

  const insertLink = () => {
    const label = linkLabel.trim();
    const href = linkHref.trim();
    if (!label || !href) {
      alert("請填寫連結文字與網址");
      return;
    }
    const snippet = `[${label}](${href})`;
    const el = textareaRef.current;
    if (el) {
      const start = el.selectionStart ?? value.length;
      const end = el.selectionEnd ?? value.length;
      onChange(value.slice(0, start) + snippet + value.slice(end));
      requestAnimationFrame(() => {
        el.focus();
        const pos = start + snippet.length;
        el.setSelectionRange(pos, pos);
      });
    } else {
      onChange(value + snippet);
    }
    setLinkLabel("");
    setLinkHref("");
  };

  const insertAtCursor = (snippet: string) => {
    const el = textareaRef.current;
    if (el) {
      const start = el.selectionStart ?? value.length;
      const end = el.selectionEnd ?? value.length;
      onChange(value.slice(0, start) + snippet + value.slice(end));
      requestAnimationFrame(() => {
        el.focus();
        const pos = start + snippet.length;
        el.setSelectionRange(pos, pos);
      });
    } else {
      onChange(value + snippet);
    }
  };

  const insertParagraphBreak = () => insertAtCursor("\n\n");

  const previewHtml = useMemo(() => previewFeatureHtml(value), [value]);

  return (
    <div className="rounded-lg border border-ui-border-base bg-ui-bg-subtle p-3 space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-ui-fg-subtle">段落 {index + 1}</Label>
        <div className="flex gap-1">
          <Button
            type="button"
            size="small"
            variant="transparent"
            onClick={insertParagraphBreak}
            className="text-ui-fg-subtle"
          >
            插入空行分段
          </Button>
        </div>
      </div>
      <div className="flex items-start gap-2">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={`輸入此段內容… Enter 換行，空一行開始新段落，可插入 [文字](網址) 連結`}
          rows={5}
          className="txt-compact-small flex-1 w-full min-h-[120px] resize-y rounded-md border border-ui-border-base bg-ui-bg-base px-3 py-2 text-ui-fg-base shadow-borders-base outline-none focus:border-ui-border-interactive whitespace-pre-wrap"
        />
        <Button
          type="button"
          variant="transparent"
          size="small"
          onClick={onRemove}
          className="text-ui-fg-error shrink-0 mt-1"
        >
          <Trash />
        </Button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-2 items-end">
        <div>
          <Label htmlFor={`link-label-${index}`} className="mb-1">
            連結文字
          </Label>
          <Input
            id={`link-label-${index}`}
            placeholder="例：最佳日本旅遊 eSIM"
            value={linkLabel}
            onChange={(e) => setLinkLabel(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor={`link-href-${index}`} className="mb-1">
            連結網址
          </Label>
          <Input
            id={`link-href-${index}`}
            placeholder="https:// 或 /blog/..."
            value={linkHref}
            onChange={(e) => setLinkHref(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                insertLink();
              }
            }}
          />
        </div>
        <Button
          type="button"
          size="small"
          variant="secondary"
          onClick={insertLink}
          className="shrink-0"
        >
          插入連結
        </Button>
      </div>

      <Text size="xsmall" className="text-ui-fg-muted">
        <strong>分段：</strong>Enter 換行；連按兩次 Enter 或按「插入空行分段」= 新段落。
        <strong className="ml-2">連結：</strong>
        格式 <code className="px-1 py-0.5 rounded bg-ui-bg-base">[文字](網址)</code>
      </Text>

      {previewHtml ? (
        <div className="rounded-md border border-dashed border-ui-border-base bg-white px-3 py-2.5">
          <Text size="xsmall" className="text-ui-fg-muted mb-1.5 block">
            前台預覽
          </Text>
          <div
            className="text-ui-fg-base text-sm leading-relaxed"
            dangerouslySetInnerHTML={{ __html: previewHtml }}
          />
        </div>
      ) : null}
    </div>
  );
}

const ProductKeyFeaturesWidget = ({
  data,
}: DetailWidgetProps<Record<string, any>>) => {
  const variantCarriers = useMemo(
    () => extractTelecomCarriers(data),
    [data],
  );

  const [features, setFeatures] = useState<CarrierFeaturesMap>(() =>
    mergeCarrierMaps(parseCarrierFeatures(data.metadata), variantCarriers),
  );
  const [newCarrier, setNewCarrier] = useState("");
  const [openItems, setOpenItems] = useState<string[]>(() =>
    variantCarriers.slice(0, 1),
  );
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const carrierKeys = useMemo(
    () => Object.keys(features).sort((a, b) => a.localeCompare(b, "zh-Hant")),
    [features],
  );

  const markDirty = useCallback(() => setDirty(true), []);

  const syncFromVariants = () => {
    if (!variantCarriers.length) {
      alert("此商品變體中尚未偵測到電信商選項。請確認變體有「電信商」類型的 Product Option。");
      return;
    }
    setFeatures((prev) => mergeCarrierMaps(prev, variantCarriers));
    setOpenItems((prev) =>
      prev.length ? [...new Set([...prev, ...variantCarriers])] : variantCarriers.slice(0, 1),
    );
    markDirty();
  };

  const addCarrier = () => {
    const name = newCarrier.trim();
    if (!name) return;
    if (features[name]) {
      alert("此電信商已存在");
      return;
    }
    setFeatures((prev) => ({ ...prev, [name]: [""] }));
    setOpenItems((prev) => [...prev, name]);
    setNewCarrier("");
    markDirty();
  };

  const removeCarrier = (carrier: string) => {
    if (!confirm(`確定刪除「${carrier}」的重點特色？`)) return;
    setFeatures((prev) => {
      const next = { ...prev };
      delete next[carrier];
      return next;
    });
    setOpenItems((prev) => prev.filter((k) => k !== carrier));
    markDirty();
  };

  const addBullet = (carrier: string) => {
    setFeatures((prev) => ({
      ...prev,
      [carrier]: [...(prev[carrier] || []), ""],
    }));
    markDirty();
  };

  const updateBullet = (carrier: string, index: number, value: string) => {
    setFeatures((prev) => ({
      ...prev,
      [carrier]: prev[carrier].map((b, i) => (i === index ? value : b)),
    }));
    markDirty();
  };

  const removeBullet = (carrier: string, index: number) => {
    setFeatures((prev) => ({
      ...prev,
      [carrier]: prev[carrier].filter((_, i) => i !== index),
    }));
    markDirty();
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload = sanitizeForSave(features);
      const response = await fetch(`/admin/products/${data.id}`, {
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

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(
          errData.message || errData.type || "儲存失敗，請稍後再試",
        );
      }

      setDirty(false);
      alert("重點特色已儲存！前台將在快取更新後顯示（約 1 分鐘）。");
    } catch (error: any) {
      alert(`儲存失敗：${error.message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Container className="divide-y p-0 mt-4">
      <div className="flex flex-col gap-3 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <Heading level="h2">重點特色（依電信商）</Heading>
          <Text size="small" className="text-ui-fg-subtle mt-1">
            每個商品獨立設定。電信商名稱需與此商品的變體選項一致（不同國家方案會有不同電信商）。
          </Text>
          {variantCarriers.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              <Text size="xsmall" className="text-ui-fg-subtle shrink-0">
                變體偵測到：
              </Text>
              {variantCarriers.map((c) => (
                <Badge key={c} size="2xsmall" color="grey">
                  {c}
                </Badge>
              ))}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {dirty && (
            <Badge size="small" color="orange">
              尚未儲存
            </Badge>
          )}
          <Button
            size="small"
            variant="secondary"
            type="button"
            onClick={syncFromVariants}
          >
            從變體同步電信商
          </Button>
          <Button
            size="small"
            variant="primary"
            type="button"
            onClick={handleSave}
            disabled={!dirty}
            isLoading={saving}
          >
            儲存
          </Button>
        </div>
      </div>

      <div className="px-6 py-4 space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1">
            <Label htmlFor="new-carrier">新增電信商區塊</Label>
            <Input
              id="new-carrier"
              placeholder="需與變體選項名稱完全一致，例如 AIS / DTAC"
              value={newCarrier}
              onChange={(e) => setNewCarrier(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addCarrier();
              }}
            />
          </div>
          <Button
            type="button"
            variant="secondary"
            size="small"
            onClick={addCarrier}
            className="shrink-0"
          >
            <PlusMini /> 新增
          </Button>
        </div>

        {carrierKeys.length === 0 ? (
          <div className="rounded-lg border border-dashed border-ui-border-base p-8 text-center">
            <Text size="small" className="text-ui-fg-subtle">
              尚無電信商區塊。請按「從變體同步電信商」或手動新增。
            </Text>
          </div>
        ) : (
          <ProgressAccordion
            type="multiple"
            value={openItems}
            onValueChange={setOpenItems}
          >
            {carrierKeys.map((carrier) => {
              const bullets = features[carrier] || [];
              const filled = bullets.filter((b) => b.replace(/\s/g, "").length)
                .length;
              const status =
                filled > 0 ? "completed" : bullets.length ? "in-progress" : "not-started";

              return (
                <ProgressAccordion.Item key={carrier} value={carrier}>
                  <ProgressAccordion.Header status={status}>
                    <div className="flex w-full items-center justify-between gap-3 pr-2">
                      <span className="font-medium">{carrier}</span>
                      <Badge size="2xsmall">{filled} 條</Badge>
                    </div>
                  </ProgressAccordion.Header>
                  <ProgressAccordion.Content>
                    <div className="space-y-3 pb-2">
                      {bullets.map((bullet, index) => (
                        <FeatureBulletRow
                          key={`${carrier}-${index}`}
                          index={index}
                          value={bullet}
                          onChange={(val) => updateBullet(carrier, index, val)}
                          onRemove={() => removeBullet(carrier, index)}
                        />
                      ))}

                      <div className="flex flex-wrap gap-2 pt-1">
                        <Button
                          type="button"
                          size="small"
                          variant="secondary"
                          onClick={() => addBullet(carrier)}
                        >
                          <PlusMini /> 新增一段
                        </Button>
                        <Button
                          type="button"
                          size="small"
                          variant="transparent"
                          className="text-ui-fg-error"
                          onClick={() => removeCarrier(carrier)}
                        >
                          刪除此電信商
                        </Button>
                      </div>
                    </div>
                  </ProgressAccordion.Content>
                </ProgressAccordion.Item>
              );
            })}
          </ProgressAccordion>
        )}
      </div>
    </Container>
  );
};

export const config = defineWidgetConfig({
  zone: "product.details.after",
});

export default ProductKeyFeaturesWidget;
