import { useEffect, useMemo, useState } from "react";
import { defineWidgetConfig } from "@medusajs/admin-sdk";
import type { DetailWidgetProps, AdminProduct } from "@medusajs/framework/types";
import { useShowEsimCarrierWidgets } from "../lib/useIsPhysicalProduct";

/**
 * 商品頁小工具：設定「專屬連結夥伴」各電信商的分潤％／旅客折扣％。
 *
 * 呼叫 /admin/product-partner-terms（見 src/api/admin/product-partner-terms/route.ts），
 * 該路由位於 /admin/* 之下，由 Medusa 內建管理員登入驗證保護——
 * 只有登入 Medusa 後台的管理員才能讀取或修改，不再透過對外公開的
 * /store 端點與共用密鑰。
 */

type PercentMap = Record<string, number>;

type TermsResponse = {
  carriers: string[];
  carrier_partner_rate_by_carrier: PercentMap;
  carrier_referral_discount_by_carrier: PercentMap;
};

const inputStyle: React.CSSProperties = {
  width: "88px",
  padding: "6px 8px",
  borderRadius: 6,
  border: "1px solid #e5e7eb",
  fontSize: 13,
  textAlign: "right",
};

const ProductPartnerTermsWidgetInner = ({
  data,
}: DetailWidgetProps<AdminProduct>) => {
  const productId = data.id;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [carriers, setCarriers] = useState<string[]>([]);
  const [rateMap, setRateMap] = useState<PercentMap>({});
  const [discountMap, setDiscountMap] = useState<PercentMap>({});
  const [draft, setDraft] = useState<
    Record<string, { rate: string; discount: string }>
  >({});
  const [savingCarrier, setSavingCarrier] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(
        `/admin/product-partner-terms?product_id=${encodeURIComponent(productId)}`,
        { credentials: "include" },
      );
      const json: TermsResponse & { error?: string } = await res.json();
      if (!res.ok) throw new Error(json.error || "讀取失敗");

      setCarriers(json.carriers || []);
      setRateMap(json.carrier_partner_rate_by_carrier || {});
      setDiscountMap(json.carrier_referral_discount_by_carrier || {});

      const nextDraft: Record<string, { rate: string; discount: string }> = {};
      for (const c of json.carriers || []) {
        nextDraft[c] = {
          rate:
            json.carrier_partner_rate_by_carrier?.[c] != null
              ? String(json.carrier_partner_rate_by_carrier[c])
              : "",
          discount:
            json.carrier_referral_discount_by_carrier?.[c] != null
              ? String(json.carrier_referral_discount_by_carrier[c])
              : "",
        };
      }
      setDraft(nextDraft);
    } catch (err) {
      setError(err instanceof Error ? err.message : "讀取失敗");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId]);

  const save = async (carrier: string) => {
    setSavingCarrier(carrier);
    setMessage("");
    setError("");
    const entry = draft[carrier] || { rate: "", discount: "" };
    try {
      const res = await fetch(`/admin/product-partner-terms`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          product_id: productId,
          carrier,
          partner_rate_percent: entry.rate === "" ? null : Number(entry.rate),
          referral_discount_percent:
            entry.discount === "" ? null : Number(entry.discount),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "儲存失敗");

      setRateMap(json.carrier_partner_rate_by_carrier || {});
      setDiscountMap(json.carrier_referral_discount_by_carrier || {});
      setMessage(`已儲存 ${carrier}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "儲存失敗");
    } finally {
      setSavingCarrier(null);
    }
  };

  const hasCarriers = carriers.length > 0;

  const summary = useMemo(() => {
    return carriers.map((c) => ({
      carrier: c,
      rate: rateMap[c],
      discount: discountMap[c],
    }));
  }, [carriers, rateMap, discountMap]);

  return (
    <div
      style={{
        background: "#fff",
        border: "1px solid #e5e7eb",
        borderRadius: 12,
        padding: 20,
      }}
    >
      <div style={{ marginBottom: 12 }}>
        <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>
          專屬連結夥伴：分潤％／旅客折扣％
        </h2>
        <p style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>
          依「電信商」選項分別設定。旅客用專屬連結／折扣碼下單時，系統會依購物車商品電信商套用對應趴數；夥伴後台「方案分潤一覽」會顯示此處設定。
        </p>
      </div>

      {loading ? (
        <p style={{ fontSize: 13, color: "#9ca3af" }}>讀取中…</p>
      ) : !hasCarriers ? (
        <p style={{ fontSize: 13, color: "#9ca3af" }}>
          此商品尚未設定「電信商」選項，無法個別設定分潤／折扣。
        </p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#6b7280", fontSize: 11 }}>
                <th style={{ padding: "6px 8px" }}>電信商</th>
                <th style={{ padding: "6px 8px", textAlign: "right" }}>
                  分潤％（成本 ×）
                </th>
                <th style={{ padding: "6px 8px", textAlign: "right" }}>
                  旅客折扣％
                </th>
                <th style={{ padding: "6px 8px" }} />
              </tr>
            </thead>
            <tbody>
              {summary.map(({ carrier }) => {
                const entry = draft[carrier] || { rate: "", discount: "" };
                return (
                  <tr key={carrier} style={{ borderTop: "1px solid #f3f4f6" }}>
                    <td style={{ padding: "8px", fontWeight: 600 }}>{carrier}</td>
                    <td style={{ padding: "8px", textAlign: "right" }}>
                      <input
                        type="number"
                        min={0}
                        max={100}
                        style={inputStyle}
                        value={entry.rate}
                        onChange={(e) =>
                          setDraft((prev) => ({
                            ...prev,
                            [carrier]: { ...entry, rate: e.target.value },
                          }))
                        }
                        placeholder="例：25"
                      />
                    </td>
                    <td style={{ padding: "8px", textAlign: "right" }}>
                      <input
                        type="number"
                        min={0}
                        max={50}
                        style={inputStyle}
                        value={entry.discount}
                        onChange={(e) =>
                          setDraft((prev) => ({
                            ...prev,
                            [carrier]: { ...entry, discount: e.target.value },
                          }))
                        }
                        placeholder="例：5"
                      />
                    </td>
                    <td style={{ padding: "8px" }}>
                      <button
                        type="button"
                        onClick={() => save(carrier)}
                        disabled={savingCarrier === carrier}
                        style={{
                          padding: "6px 12px",
                          borderRadius: 6,
                          border: "none",
                          background: "#6d28d9",
                          color: "#fff",
                          fontSize: 12,
                          fontWeight: 700,
                          cursor: "pointer",
                          opacity: savingCarrier === carrier ? 0.6 : 1,
                        }}
                      >
                        {savingCarrier === carrier ? "儲存中…" : "儲存"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {message ? (
        <p style={{ fontSize: 12, color: "#059669", marginTop: 10 }}>{message}</p>
      ) : null}
      {error ? (
        <p style={{ fontSize: 12, color: "#dc2626", marginTop: 10 }}>{error}</p>
      ) : null}
    </div>
  );
};

const ProductPartnerTermsWidget = (
  props: DetailWidgetProps<AdminProduct>,
) => {
  const show = useShowEsimCarrierWidgets(props.data as Record<string, any>);
  if (!show) return null;
  return <ProductPartnerTermsWidgetInner {...props} />;
};

export const config = defineWidgetConfig({
  zone: "product.details.side.after",
});

export default ProductPartnerTermsWidget;
