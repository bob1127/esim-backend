import React, { useCallback, useMemo, useState } from "react";
import { defineWidgetConfig } from "@medusajs/admin-sdk";
import { DetailWidgetProps } from "@medusajs/framework/types";
import {
  Badge,
  Button,
  Checkbox,
  Container,
  Heading,
  Label,
  Text,
} from "@medusajs/ui";
import { useShowEsimCarrierWidgets } from "../lib/useIsPhysicalProduct";

const METADATA_KEY = "hot_sale_telecoms";

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

const parseHotSaleTelecoms = (
  metadata?: Record<string, unknown> | null,
): string[] => {
  const raw = metadata?.[METADATA_KEY];
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
    } catch {
      return [];
    }
  }
  return [];
};

const ProductTelecomHotSaleWidgetInner = ({
  data,
}: DetailWidgetProps<Record<string, any>>) => {
  const carriers = useMemo(() => extractTelecomCarriers(data), [data]);
  const [selected, setSelected] = useState<string[]>(() =>
    parseHotSaleTelecoms(data.metadata),
  );
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const toggleCarrier = useCallback((carrier: string, checked: boolean) => {
    setSelected((prev) => {
      if (checked) {
        return prev.includes(carrier) ? prev : [...prev, carrier];
      }
      return prev.filter((item) => item !== carrier);
    });
    setDirty(true);
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload = selected.filter(Boolean);
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
      alert("推薦熱銷設定已儲存！前台將顯示 Hot Sale 標籤。");
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
          <Heading level="h2">方案推薦熱銷</Heading>
          <Text size="small" className="text-ui-fg-subtle mt-1">
            勾選的電信商會在前台「方案選擇」旁顯示 Hot Sale 標籤圖。
          </Text>
        </div>
        <div className="flex items-center gap-2">
          {dirty && (
            <Badge size="small" color="orange">
              尚未儲存
            </Badge>
          )}
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

      <div className="px-6 py-4">
        {carriers.length === 0 ? (
          <Text size="small" className="text-ui-fg-subtle">
            此商品尚無電信商選項。請先建立含「電信商」的變體。
          </Text>
        ) : (
          <div className="space-y-3">
            {carriers.map((carrier) => {
              const checked = selected.includes(carrier);
              return (
                <label
                  key={carrier}
                  className="flex items-center gap-3 rounded-lg border border-ui-border-base px-4 py-3 cursor-pointer hover:bg-ui-bg-subtle transition-colors"
                >
                  <Checkbox
                    checked={checked}
                    onCheckedChange={(value) =>
                      toggleCarrier(carrier, value === true)
                    }
                  />
                  <div className="flex-1 min-w-0">
                    <Label className="font-medium cursor-pointer">
                      {carrier}
                    </Label>
                    <Text size="xsmall" className="text-ui-fg-muted">
                      推薦熱銷
                    </Text>
                  </div>
                  {checked ? (
                    <Badge size="2xsmall" color="orange">
                      Hot Sale
                    </Badge>
                  ) : null}
                </label>
              );
            })}
          </div>
        )}
      </div>
    </Container>
  );
};

const ProductTelecomHotSaleWidget = (
  props: DetailWidgetProps<Record<string, any>>,
) => {
  const show = useShowEsimCarrierWidgets(props.data);
  if (!show) return null;
  return <ProductTelecomHotSaleWidgetInner {...props} />;
};

export const config = defineWidgetConfig({
  zone: "product.details.after",
});

export default ProductTelecomHotSaleWidget;
