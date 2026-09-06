/**
 * 查詢單筆訂單：付款／eSIM QR／發票／LINE 相關 metadata
 *
 *   npx medusa exec ./src/scripts/inspect-order.ts 01M1RCBE7ADC9PG6FRFZ92WDQH
 */
import { ExecArgs } from "@medusajs/framework/types"
import { ORDER_TOTALS_FIELDS } from "../lib/orderAmount"

function resolveOrderId(raw: string): string {
  const s = String(raw || "").trim()
  if (!s) return ""
  return s.startsWith("order_") ? s : `order_${s}`
}

export default async function inspectOrder({ container, args }: ExecArgs) {
  const orderId = resolveOrderId(String(args?.[0] || ""))
  if (!orderId) throw new Error("請傳訂單 id，例如 01M1RCBE7ADC9PG6FRFZ92WDQH")

  const query = container.resolve("query") as {
    graph: (args: Record<string, unknown>) => Promise<{ data: any[] }>
  }

  const { data: orders } = await query.graph({
    entity: "order",
    fields: [
      "id",
      "email",
      "status",
      "currency_code",
      "metadata",
      "created_at",
      "updated_at",
      // items.* 不可省：少了它 total 會顯示 0（見 lib/orderAmount ORDER_TOTALS_FIELDS）
      ...ORDER_TOTALS_FIELDS,
      "items.title",
      "items.product_title",
      "items.variant_sku",
      "items.quantity",
      "items.unit_price",
      "items.metadata",
    ],
    filters: { id: [orderId] },
  })

  const order = orders?.[0]
  if (!order) throw new Error(`找不到訂單 ${orderId}`)

  const meta = (order.metadata || {}) as Record<string, unknown>
  let qrs: any = meta.esim_qrcodes
  if (typeof qrs === "string") {
    try {
      qrs = JSON.parse(qrs)
    } catch {
      /* keep string */
    }
  }

  const related: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(meta)) {
    if (/line|notify|push|mail|invoice|qr|fulfill|neweb|pay|email|ezpay|topup|iccid/i.test(k)) {
      if (k === "esim_qrcodes") {
        related[k] = Array.isArray(qrs) ? `[array:${qrs.length}]` : typeof v
      } else if (typeof v === "string" && v.length > 240) {
        related[k] = `${v.slice(0, 240)}…`
      } else {
        related[k] = v
      }
    }
  }

  const out = {
    id: order.id,
    email: order.email,
    status: order.status,
    total: order.total,
    currency: order.currency_code,
    created_at: order.created_at,
    updated_at: order.updated_at,
    items: (order.items || []).map((it: any) => ({
      title: it.title || it.product_title,
      sku: it.variant_sku,
      qty: it.quantity,
      unit_price: it.unit_price,
    })),
    payment: {
      newebpay_status: meta.newebpay_status || null,
      newebpay_pay_time: meta.newebpay_pay_time || meta.PayTime || null,
      newebpay_amount: meta.newebpay_amount || null,
      newebpay_trade_no: meta.newebpay_trade_no || meta.TradeNo || null,
      payment_type:
        meta.newebpay_payment_type || meta.PaymentType || meta.payment_method || null,
      linepay_pay_time: meta.linepay_pay_time || null,
    },
    fulfill: {
      has_esim_qrcodes: !!meta.esim_qrcodes,
      qr_count: Array.isArray(qrs) ? qrs.length : 0,
      qrs: Array.isArray(qrs)
        ? qrs.map((q: any, i: number) => ({
            i,
            name: q?.name || q?.title || null,
            hasSrc: !!(q?.src || q?.qr || q?.image),
            iccid: q?.iccid || null,
            topupId: q?.topupId || q?.topup_id || null,
            hasLpa: !!(q?.lpa || q?.activationCode || q?.universal_link),
          }))
        : null,
      esim_fulfill_at: meta.esim_fulfill_at || meta.fulfilled_at || null,
      fulfill_error: meta.esim_fulfill_error || meta.fulfill_error || null,
    },
    invoice: {
      number: meta.ezpay_invoice_number || null,
      random: meta.ezpay_invoice_random || null,
      at: meta.ezpay_invoice_at || null,
      error: meta.ezpay_invoice_error || meta.invoice_error || null,
    },
    line: {
      line_user_id: meta.line_user_id || meta.lineUserId || null,
      order_line_notified:
        meta.line_order_notified_at || meta.order_line_notified || null,
      admin_line_notified:
        meta.admin_line_notified_at || meta.admin_line_notified || null,
    },
    meta_keys: Object.keys(meta).sort(),
    meta_related: related,
  }

  console.log(JSON.stringify(out, null, 2))
}
