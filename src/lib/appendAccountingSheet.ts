/**
 * 付款成功 → 前台 append-accounting → Google Sheet
 */
export type AccountingPayload = {
  orderId: string;
  amount: number;
  paymentProvider: "newebpay" | "linepay";
  payTime?: string;
  tradeNo?: string;
  customerEmail?: string | null;
  items?: Array<{
    name?: string;
    quantity?: number;
    unitCost?: number;
    cost_price?: number;
    b2b_price?: number;
  }>;
  isPartner?: boolean;
  isPartnerOrder?: boolean;
  partnerStoreId?: string;
  referralCode?: string;
  note?: string;
};

function buildAccountingPayload(order: {
  id: string;
  email?: string | null;
  metadata?: Record<string, unknown> | null;
  items?: Array<any>;
}, params: {
  amount: number;
  paymentProvider: "newebpay" | "linepay";
  payTime?: string;
  tradeNo?: string;
}): AccountingPayload {
  const meta = order.metadata || {};
  const accountingItems = (order.items || []).map((it: any) => ({
    name: it.product_title || it.title,
    quantity: it.quantity,
    unitCost:
      Number(it.variant?.metadata?.cost_price) ||
      Number(it.variant?.metadata?.b2b_price) ||
      Number(it.metadata?.cost_price) ||
      undefined,
  }));

  return {
    orderId: order.id,
    amount: params.amount,
    paymentProvider: params.paymentProvider,
    payTime: params.payTime,
    tradeNo: params.tradeNo,
    customerEmail: order.email,
    items: accountingItems,
    isPartnerOrder: !!meta.is_partner_order,
    partnerStoreId: meta.partner_store_id
      ? String(meta.partner_store_id)
      : undefined,
    referralCode: meta.jeko_referral_code
      ? String(meta.jeko_referral_code)
      : undefined,
  };
}

export { buildAccountingPayload };

export async function appendAccountingSheet(
  payload: AccountingPayload,
): Promise<void> {
  const base = process.env.FULFILLMENT_INTERNAL_URL?.replace(/\/$/, "");
  const secret = process.env.FULFILLMENT_INTERNAL_SECRET;
  if (!base || !secret) return;

  try {
    const res = await fetch(`${base}/api/internal/append-accounting`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Fulfillment-Secret": secret,
      },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.warn(
        "[appendAccountingSheet] failed:",
        data?.message || res.status,
      );
      return;
    }
    if (data.skipped && data.reason === "duplicate_order_id") {
      console.log(`[appendAccountingSheet] skip duplicate ${payload.orderId}`);
      return;
    }
    console.log(
      `[appendAccountingSheet] ok ${payload.orderId}${data.tab ? ` → ${data.tab}` : ""}`,
    );
  } catch (e: any) {
    console.warn("[appendAccountingSheet]", e?.message || e);
  }
}
