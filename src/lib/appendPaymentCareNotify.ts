export type PaymentCarePayload = {
  email?: string | null
  orderNo?: string | null
  orderId?: string | null
  amount?: number | string | null
  reason?: string | null
  message?: string | null
  payloadStatus?: string | null
  method?: "newebpay" | "linepay" | string | null
  statusLabel?: string | null
  force?: boolean
}

/**
 * 呼叫前台寄送「未付款／付款失敗」關懷信（best-effort，失敗不影響金流回調）。
 */
export async function notifyPaymentCare(
  payload: PaymentCarePayload,
): Promise<void> {
  const email = String(payload.email || "")
    .trim()
    .toLowerCase()
  if (!email || !email.includes("@")) return

  const base = process.env.FULFILLMENT_INTERNAL_URL?.replace(/\/$/, "")
  const secret = process.env.FULFILLMENT_INTERNAL_SECRET
  if (!base || !secret) {
    console.warn(
      "[notifyPaymentCare] 略過：未設定 FULFILLMENT_INTERNAL_URL / SECRET",
    )
    return
  }

  try {
    const res = await fetch(`${base}/api/internal/notify-payment-care`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Fulfillment-Secret": secret,
      },
      body: JSON.stringify({
        email,
        orderNo: payload.orderNo || payload.orderId || "",
        orderId: payload.orderId || "",
        amount: payload.amount ?? "",
        reason: payload.reason || "",
        message: payload.message || "",
        payloadStatus: payload.payloadStatus || "",
        method: payload.method || "",
        statusLabel: payload.statusLabel || "",
        force: Boolean(payload.force),
      }),
    })
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      console.warn(
        "[notifyPaymentCare] failed:",
        data?.message || res.status,
      )
      return
    }
    if (data.skipped) {
      console.log(
        `[notifyPaymentCare] skipped ${email} reason=${data.reason || "unknown"}`,
      )
      return
    }
    console.log(
      `[notifyPaymentCare] ok ${email} order=${payload.orderNo || payload.orderId || ""}`,
    )
  } catch (e: any) {
    console.warn("[notifyPaymentCare]", e?.message || e)
  }
}
