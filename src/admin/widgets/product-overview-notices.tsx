import { useCallback, useMemo, useRef, useState } from "react";
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

type OverviewNotice = {
  fup_notice: string;
  activation_notice: string;
};

type OverviewNoticesMap = Record<string, OverviewNotice>;

const METADATA_KEY = "overview_notices_by_carrier";
const LINK_CLASS = "text-[#0066cc] underline";

/** 與前台 lib/productRichText.js 相同規則 */
const previewRichTextHtml = (text: string) => {
  if (!text.trim()) return "";

  const escapeHtml = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const inline = (segment: string) => {
    let out = escapeHtml(segment);
    out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
      const safeHref = String(href).trim();
      if (!/^https?:\/\//i.test(safeHref) && !safeHref.startsWith("/")) {
        return `[${label}](${href})`;
      }
      const labelHtml = escapeHtml(label).replace(
        /\*\*([^*]+)\*\*/g,
        "<strong>$1</strong>",
      );
      return `<a href="${safeHref}" class="${LINK_CLASS}">${labelHtml}</a>`;
    });
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    return out;
  };

  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((paragraph) => {
      const lines = paragraph
        .split("\n")
        .map((line) => inline(line.trim()))
        .filter(Boolean);
      return `<p style="margin:0 0 0.5rem;line-height:1.6">${lines.join("<br>")}</p>`;
    })
    .join("");
};

function OverviewRichTextField({
  label,
  hint,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [linkLabel, setLinkLabel] = useState("");
  const [linkHref, setLinkHref] = useState("");
  const [boldText, setBoldText] = useState("");

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

  const wrapSelectionBold = () => {
    const el = textareaRef.current;
    if (el && el.selectionStart !== el.selectionEnd) {
      const start = el.selectionStart ?? 0;
      const end = el.selectionEnd ?? 0;
      const selected = value.slice(start, end);
      const snippet = `**${selected}**`;
      onChange(value.slice(0, start) + snippet + value.slice(end));
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(start, start + snippet.length);
      });
      return;
    }
    const text = boldText.trim() || "粗體文字";
    insertAtCursor(`**${text}**`);
    setBoldText("");
  };

  const insertLink = () => {
    const label = linkLabel.trim();
    const href = linkHref.trim();
    if (!label || !href) {
      alert("請填寫連結文字與網址");
      return;
    }
    insertAtCursor(`[${label}](${href})`);
    setLinkLabel("");
    setLinkHref("");
  };

  const previewHtml = useMemo(() => previewRichTextHtml(value), [value]);

  return (
    <div className="space-y-2.5">
      <div>
        <Label className="mb-1 block">{label}</Label>
        {hint ? (
          <Text size="xsmall" className="text-ui-fg-muted mb-1.5 block">
            {hint}
          </Text>
        ) : null}
      </div>

      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={4}
        className="txt-compact-small w-full min-h-[100px] resize-y rounded-md border border-ui-border-base bg-ui-bg-base px-3 py-2 text-ui-fg-base shadow-borders-base outline-none focus:border-ui-border-interactive whitespace-pre-wrap"
      />

      <div className="flex flex-wrap gap-2 items-end">
        <div className="flex-1 min-w-[120px]">
          <Label className="mb-1 text-ui-fg-subtle">粗體文字</Label>
          <Input
            placeholder="選取文字後按插入，或填寫後插入"
            value={boldText}
            onChange={(e) => setBoldText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                wrapSelectionBold();
              }
            }}
          />
        </div>
        <Button
          type="button"
          size="small"
          variant="secondary"
          onClick={wrapSelectionBold}
          className="shrink-0"
        >
          插入粗體
        </Button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-2 items-end">
        <div>
          <Label className="mb-1">連結文字</Label>
          <Input
            placeholder="例：查看啟用政策"
            value={linkLabel}
            onChange={(e) => setLinkLabel(e.target.value)}
          />
        </div>
        <div>
          <Label className="mb-1">連結網址</Label>
          <Input
            placeholder="https:// 或 /operation-ios"
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
        <strong>粗體：</strong>
        <code className="mx-1 px-1 py-0.5 rounded bg-ui-bg-subtle">**文字**</code>
        <strong className="ml-2">連結：</strong>
        <code className="mx-1 px-1 py-0.5 rounded bg-ui-bg-subtle">[文字](網址)</code>
        <span className="ml-1">（可組合：**注意:** … [連結](/path)）</span>
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

const emptyNotice = (): OverviewNotice => ({
  fup_notice: "",
  activation_notice: "",
});

const parseNotices = (
  metadata?: Record<string, unknown> | null,
): OverviewNoticesMap => {
  const raw = metadata?.[METADATA_KEY];
  if (!raw) return {};
  let data: unknown = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};

  const out: OverviewNoticesMap = {};
  Object.entries(data as Record<string, unknown>).forEach(([carrier, val]) => {
    if (!val || typeof val !== "object") return;
    const row = val as Record<string, unknown>;
    out[carrier] = {
      fup_notice: String(row.fup_notice || ""),
      activation_notice: String(row.activation_notice || ""),
    };
  });
  return out;
};

const isTelecomValue = (value: string) => {
  if (!value) return false;
  if (/天|Days/i.test(value)) return false;
  if (/流量|GB|MB|吃到飽/i.test(value)) return false;
  return true;
};

const extractTelecomCarriers = (product: Record<string, any>): string[] => {
  const set = new Set<string>();
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
  product?.variants?.forEach((variant: any) => {
    variant?.options?.forEach((opt: any) => {
      const val = String(opt?.value ?? "").trim();
      if (isTelecomValue(val)) set.add(val);
    });
  });
  return [...set];
};

const mergeCarrierMaps = (
  saved: OverviewNoticesMap,
  carriers: string[],
): OverviewNoticesMap => {
  const keys = new Set([...Object.keys(saved), ...carriers]);
  const merged: OverviewNoticesMap = {};
  keys.forEach((key) => {
    merged[key] = saved[key] || emptyNotice();
  });
  return merged;
};

const sanitizeForSave = (map: OverviewNoticesMap): OverviewNoticesMap => {
  const out: OverviewNoticesMap = {};
  Object.entries(map).forEach(([carrier, notice]) => {
    const fup = notice.fup_notice.trim();
    const activation = notice.activation_notice.trim();
    if (fup || activation) {
      out[carrier] = {
        ...(fup ? { fup_notice: fup } : {}),
        ...(activation ? { activation_notice: activation } : {}),
      } as OverviewNotice;
    }
  });
  return out;
};

const ProductOverviewNoticesWidget = ({
  data,
}: DetailWidgetProps<Record<string, any>>) => {
  const variantCarriers = useMemo(
    () => extractTelecomCarriers(data),
    [data],
  );

  const [notices, setNotices] = useState<OverviewNoticesMap>(() =>
    mergeCarrierMaps(parseNotices(data.metadata), variantCarriers),
  );
  const [newCarrier, setNewCarrier] = useState("");
  const [openItems, setOpenItems] = useState<string[]>(() =>
    variantCarriers.slice(0, 1),
  );
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const carrierKeys = useMemo(
    () => Object.keys(notices).sort((a, b) => a.localeCompare(b, "zh-Hant")),
    [notices],
  );

  const markDirty = useCallback(() => setDirty(true), []);

  const syncFromVariants = () => {
    if (!variantCarriers.length) {
      alert("此商品變體中尚未偵測到電信商選項。");
      return;
    }
    setNotices((prev) => mergeCarrierMaps(prev, variantCarriers));
    setOpenItems((prev) =>
      prev.length ? [...new Set([...prev, ...variantCarriers])] : variantCarriers.slice(0, 1),
    );
    markDirty();
  };

  const addCarrier = () => {
    const name = newCarrier.trim();
    if (!name) return;
    if (notices[name]) {
      alert("此電信商已存在");
      return;
    }
    setNotices((prev) => ({ ...prev, [name]: emptyNotice() }));
    setOpenItems((prev) => [...prev, name]);
    setNewCarrier("");
    markDirty();
  };

  const removeCarrier = (carrier: string) => {
    if (!confirm(`確定刪除「${carrier}」的概覽說明？`)) return;
    setNotices((prev) => {
      const next = { ...prev };
      delete next[carrier];
      return next;
    });
    setOpenItems((prev) => prev.filter((k) => k !== carrier));
    markDirty();
  };

  const updateField = (
    carrier: string,
    field: keyof OverviewNotice,
    value: string,
  ) => {
    setNotices((prev) => ({
      ...prev,
      [carrier]: { ...prev[carrier], [field]: value },
    }));
    markDirty();
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload = sanitizeForSave(notices);
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
      alert("概覽說明已儲存！前台將在快取更新後顯示。");
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
          <Heading level="h2">概覽說明區塊</Heading>
          <Text size="small" className="text-ui-fg-subtle mt-1">
            顯示於商品頁「概覽」分頁。支援自訂<strong>粗體</strong>與<strong>超連結</strong>，儲存後約 1 分鐘內於前台更新。
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
            <Label htmlFor="overview-new-carrier">新增電信商區塊</Label>
            <Input
              id="overview-new-carrier"
              placeholder="需與變體選項名稱一致"
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
              const row = notices[carrier] || emptyNotice();
              const filled =
                (row.fup_notice.trim() ? 1 : 0) +
                (row.activation_notice.trim() ? 1 : 0);
              const status =
                filled === 2 ? "completed" : filled > 0 ? "in-progress" : "not-started";

              return (
                <ProgressAccordion.Item key={carrier} value={carrier}>
                  <ProgressAccordion.Header status={status}>
                    <div className="flex w-full items-center justify-between gap-3 pr-2">
                      <span className="font-medium">{carrier}</span>
                      <Badge size="2xsmall">{filled}/2 區塊</Badge>
                    </div>
                  </ProgressAccordion.Header>
                  <ProgressAccordion.Content>
                    <div className="space-y-5 pb-2">
                      <OverviewRichTextField
                        label="公平使用政策 (FUP) — 藍色資訊區塊"
                        hint="例：**公平使用政策 (FUP):** 高速數據用完後，降速至 128 kbps…"
                        value={row.fup_notice}
                        placeholder="公平使用政策 (FUP): …"
                        onChange={(val) =>
                          updateField(carrier, "fup_notice", val)
                        }
                      />
                      <OverviewRichTextField
                        label="啟用注意 — 黃色提醒區塊"
                        hint="例：**注意:** 我們建議您抵達後再新增 eSIM。[查看啟用政策](/operation-ios)"
                        value={row.activation_notice}
                        placeholder="注意: …"
                        onChange={(val) =>
                          updateField(carrier, "activation_notice", val)
                        }
                      />
                      <Button
                        type="button"
                        size="small"
                        variant="transparent"
                        className="text-ui-fg-error"
                        onClick={() => removeCarrier(carrier)}
                      >
                        <Trash /> 刪除此電信商
                      </Button>
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
  zone: "product.details.before",
});

export default ProductOverviewNoticesWidget;
