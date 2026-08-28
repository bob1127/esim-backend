import type { AccountingPayload } from "./appendAccountingSheet";

export async function notifyAdminNewOrder(
  payload: AccountingPayload,
): Promise<void> {
  const base = process.env.FULFILLMENT_INTERNAL_URL?.replace(/\/$/, "");
  const secret = process.env.FULFILLMENT_INTERNAL_SECRET;
  if (!base || !secret) return;

  try {
    const res = await fetch(`${base}/api/internal/notify-admin-order`, {
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
        "[notifyAdminNewOrder] failed:",
        data?.message || res.status,
      );
      return;
    }
    if (data.skipped && data.reason === "not_configured") return;
    console.log(`[notifyAdminNewOrder] ok ${payload.orderId}`);
  } catch (e: any) {
    console.warn("[notifyAdminNewOrder]", e?.message || e);
  }
}
