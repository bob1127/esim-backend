/**
 * 印出訂單 email / esim_qrcodes 摘要（除錯用）
 * npx medusa exec ./src/scripts/inspect-order.ts 01M0Z1GFZN0BXA61TJ8RHGT4ZE
 */
import { ExecArgs } from "@medusajs/framework/types"

export default async function inspectOrder({ container, args }: ExecArgs) {
  const raw = String(args?.[0] || "").trim()
  const orderId = raw.startsWith("order_") ? raw : `order_${raw}`
  const query = container.resolve("query") as {
    graph: (a: Record<string, unknown>) => Promise<{ data: any[] }>
  }
  const { data } = await query.graph({
    entity: "order",
    fields: ["id", "email", "total", "payment_status", "metadata", "items.product_title", "items.title"],
    filters: { id: [orderId] },
  })
  const o = data?.[0]
  if (!o) {
    console.log("NOT_FOUND", orderId)
    return
  }
  let qrs: any[] = []
  try {
    const rawQr = o.metadata?.esim_qrcodes
    qrs = typeof rawQr === "string" ? JSON.parse(rawQr) : Array.isArray(rawQr) ? rawQr : []
  } catch {}
  console.log(
    JSON.stringify(
      {
        id: o.id,
        email: o.email,
        payment_status: o.payment_status,
        linepay_pay_time: o.metadata?.linepay_pay_time,
        supabase_user_id: o.metadata?.supabase_user_id,
        line_user_id: o.metadata?.line_user_id,
        items: (o.items || []).map((it: any) => it.product_title || it.title),
        qrCount: qrs.length,
        qrSummary: qrs.map((q) => ({
          name: q?.name || q?.productName,
          hasSrc: Boolean(q?.src),
          hasLpa: Boolean(q?.lpa),
          topupId: q?.topupId,
          iccid: q?.iccid,
        })),
      },
      null,
      2,
    ),
  )
}
