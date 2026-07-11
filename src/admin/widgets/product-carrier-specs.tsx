import React, { useCallback, useMemo, useState } from "react";
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

const METADATA_KEY = "carrier_specs_by_carrier";

type CarrierSpecEntry = {
  ip_type: string;
  route_type: string;
  network: string;
  speed_rule: string;
  apps: string;
};

type CarrierSpecsMap = Record<string, CarrierSpecEntry>;

const SPEC_FIELDS: {
  key: keyof CarrierSpecEntry;
  label: string;
  placeholder: string;
}[] = [
  { key: "ip_type", label: "IP 類型", placeholder: "例：日本 IP" },
  { key: "route_type", label: "線路類型", placeholder: "例：日本原生" },
  { key: "network", label: "網路速度", placeholder: "例：4G / LTE" },
  {
    key: "speed_rule",
    label: "限速說明",
    placeholder: "例：依 FUP 規範限制",
  },
  {
    key: "apps",
    label: "支援應用",
    placeholder: "例：Google, IG, FB, Line, 熱點分享",
  },
];

const emptyEntry = (): CarrierSpecEntry => ({
  ip_type: "",
  route_type: "",
  network: "",
  speed_rule: "",
  apps: "",
});

const normalizeCarrierSpecEntry = (value: unknown): CarrierSpecEntry => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return emptyEntry();
  }
  const obj = value as Record<string, unknown>;
  return {
    ip_type: String(obj.ip_type ?? "").trim(),
    route_type: String(obj.route_type ?? "").trim(),
    network: String(obj.network ?? "").trim(),
    speed_rule: String(obj.speed_rule ?? "").trim(),
    apps: String(obj.apps ?? "").trim(),
  };
};

const parseCarrierSpecs = (
  metadata?: Record<string, unknown> | null,
): CarrierSpecsMap => {
  const raw = metadata?.[METADATA_KEY];
  if (!raw) return {};

  const parseObject = (parsed: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(parsed).map(([k, v]) => [k, normalizeCarrierSpecEntry(v)]),
    );

  if (typeof raw === "object" && !Array.isArray(raw)) {
    return parseObject(raw as Record<string, unknown>);
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parseObject(parsed);
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

  return [...set].sort((a, b) => a.localeCompare(b, "zh-Hant"));
};

const mergeCarrierMaps = (
  saved: CarrierSpecsMap,
  carriers: string[],
): CarrierSpecsMap => {
  const keys = new Set([...Object.keys(saved), ...carriers]);
  const merged: CarrierSpecsMap = {};
  keys.forEach((key) => {
    merged[key] = saved[key] ? { ...saved[key] } : emptyEntry();
  });
  return merged;
};

const sanitizeForSave = (map: CarrierSpecsMap): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  Object.entries(map).forEach(([carrier, entry]) => {
    const payload: Record<string, string> = {};
    SPEC_FIELDS.forEach(({ key }) => {
      const value = entry[key].trim();
      if (value) payload[key] = value;
    });
    if (Object.keys(payload).length) out[carrier] = payload;
  });
  return out;
};

const ProductCarrierSpecsWidget = ({
  data,
}: DetailWidgetProps<Record<string, any>>) => {
  const variantCarriers = useMemo(() => extractTelecomCarriers(data), [data]);
  const [specs, setSpecs] = useState<CarrierSpecsMap>(() =>
    mergeCarrierMaps(parseCarrierSpecs(data.metadata), variantCarriers),
  );
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [newCarrier, setNewCarrier] = useState("");

  const carriers = useMemo(() => Object.keys(specs).sort(), [specs]);

  const markDirty = useCallback(() => setDirty(true), []);

  const syncFromVariants = () => {
    setSpecs((prev) => mergeCarrierMaps(prev, variantCarriers));
    markDirty();
  };

  const updateField = (
    carrier: string,
    key: keyof CarrierSpecEntry,
    value: string,
  ) => {
    setSpecs((prev) => ({
      ...prev,
      [carrier]: {
        ...prev[carrier],
        [key]: value,
      },
    }));
    markDirty();
  };

  const addCarrier = () => {
    const name = newCarrier.trim();
    if (!name) {
      alert("請輸入電信商名稱");
      return;
    }
    if (specs[name]) {
      alert("此電信商已存在");
      return;
    }
    setSpecs((prev) => ({ ...prev, [name]: emptyEntry() }));
    setNewCarrier("");
    markDirty();
  };

  const removeCarrier = (carrier: string) => {
    if (!confirm(`確定刪除「${carrier}」的規格設定？`)) return;
    setSpecs((prev) => {
      const next = { ...prev };
      delete next[carrier];
      return next;
    });
    markDirty();
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload = sanitizeForSave(specs);
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
      alert("方案規格已儲存！留空的欄位前台不會顯示。");
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
          <Heading level="h2">方案規格 icon（依電信商）</Heading>
          <Text size="small" className="text-ui-fg-subtle mt-1">
            設定商品頁「數據量」下方的 IP、線路、網速等 icon
            區塊。留空欄位前台不顯示。
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
        <div className="flex flex-col sm:flex-row gap-2">
          <Input
            placeholder="手動新增電信商名稱（需與變體一致）"
            value={newCarrier}
            onChange={(e) => setNewCarrier(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addCarrier();
              }
            }}
          />
          <Button
            size="small"
            variant="secondary"
            type="button"
            onClick={addCarrier}
            className="shrink-0"
          >
            新增電信商
          </Button>
        </div>

        {carriers.length === 0 ? (
          <Text size="small" className="text-ui-fg-subtle">
            尚無電信商。請按「從變體同步電信商」或手動新增。
          </Text>
        ) : (
          <ProgressAccordion type="multiple">
            {carriers.map((carrier) => {
              const entry = specs[carrier] || emptyEntry();
              const filledCount = SPEC_FIELDS.filter(
                ({ key }) => entry[key].trim(),
              ).length;

              return (
                <ProgressAccordion.Item key={carrier} value={carrier}>
                  <ProgressAccordion.Header
                    status={filledCount > 0 ? "completed" : "not-started"}
                  >
                    <div className="flex items-center gap-2">
                      <Text weight="plus">{carrier}</Text>
                      <Badge size="2xsmall" color="grey">
                        {filledCount}/{SPEC_FIELDS.length} 欄
                      </Badge>
                    </div>
                  </ProgressAccordion.Header>
                  <ProgressAccordion.Content>
                    <div className="space-y-3 pt-2">
                      {SPEC_FIELDS.map(({ key, label, placeholder }) => (
                        <div key={key}>
                          <Label className="mb-1.5">{label}</Label>
                          <Input
                            value={entry[key]}
                            placeholder={placeholder}
                            onChange={(e) =>
                              updateField(carrier, key, e.target.value)
                            }
                          />
                        </div>
                      ))}
                      <div className="pt-2">
                        <Button
                          size="small"
                          variant="danger"
                          type="button"
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

export default ProductCarrierSpecsWidget;
