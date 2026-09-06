/**
 * 用既有 topup_id 補抓 QR／寄信／寫回 Medusa（不再向供應商 subscribe，避免重複開卡）
 *
 * 用法（esim-backend）：
 *   FULFILLMENT_INTERNAL_URL=http://localhost:3000 \
 *   npx medusa exec ./src/scripts/recover-topup-fulfill.ts \
 *   01M0Z1GFZN0BXA61TJ8RHGT4ZE 202608262054168817938050
 */
import { ExecArgs } from "@medusajs/framework/types"
import { ORDER_TOTALS_FIELDS } from "../lib/orderAmount"

function normalizeQrSrc(raw: unknown): string {
  const str = String(raw || "")
  if (!str) return ""
  return str.startsWith("http") || str.startsWith("data:image/")
    ? str
    : `data:image/png;base64,${str}`
}

function resolveOrderId(raw: string): string {
  const s = String(raw || "").trim()
  if (!s) return ""
  return s.startsWith("order_") ? s : `order_${s}`
}

export default async function recoverTopupFulfill({ container, args }: ExecArgs) {
  const orderId = resolveOrderId(String(args?.[0] || ""))
  const topupId = String(args?.[1] || "").trim()
  if (!orderId || !topupId) {
    throw new Error("用法: <orderNo> <topup_id>")
  }

  const fulfillBase = (process.env.FULFILLMENT_INTERNAL_URL || "").replace(/\/$/, "")
  const fulfillSecret = process.env.FULFILLMENT_INTERNAL_SECRET || ""
  if (!fulfillBase || fulfillSecret.length < 16) {
    throw new Error("缺少 FULFILLMENT_INTERNAL_URL / FULFILLMENT_INTERNAL_SECRET")
  }

  const query = container.resolve("query") as {
    graph: (args: Record<string, unknown>) => Promise<{ data: any[] }>
  }
  const orderModule = container.resolve("order") as {
    updateOrders: (
      data: Array<{ id: string; metadata: Record<string, unknown> }>,
    ) => Promise<unknown>
  }

  const { data: orders } = await query.graph({
    entity: "order",
    fields: [
      "id",
      "email",
      "metadata",
      // items.* 不可省：少了它 total 會變 0（見 lib/orderAmount ORDER_TOTALS_FIELDS）
      ...ORDER_TOTALS_FIELDS,
      "items.title",
      "items.product_title",
    ],
    filters: { id: [orderId] },
  })
  const order = orders?.[0]
  if (!order) throw new Error(`找不到訂單 ${orderId}`)

  const orderNo = String(order.id).replace(/^order_/, "")
  const amount = Math.round(
    Number(order.metadata?.linepay_amount || order.metadata?.newebpay_amount || order.total || 0),
  )
  const productName =
    order.items?.[0]?.product_title || order.items?.[0]?.title || "eSIM"

  console.log(
    `[recover-topup] order=${order.id} topup=${topupId} email=${order.email}`,
  )

  const headers = {
    "Content-Type": "application/json",
    "X-Fulfillment-Secret": fulfillSecret,
  }

  const recoverRes = await fetch(`${fulfillBase}/api/internal/fulfill-from-topup`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      orderId: order.id,
      email: order.email,
      topupId,
      productName,
    }),
  })
  const raw = await recoverRes.text()
  let data: any = {}
  try {
    data = raw ? JSON.parse(raw) : {}
  } catch {
    data = { message: raw.slice(0, 400) }
  }
  if (!recoverRes.ok || !Array.isArray(data?.qrcodes) || !data.qrcodes.length) {
    throw new Error(
      `補抓失敗 HTTP ${recoverRes.status}: ${data?.message || raw.slice(0, 400)}`,
    )
  }

  const { data: latestRows } = await query.graph({
    entity: "order",
    fields: ["id", "metadata"],
    filters: { id: [order.id] },
  })
  const latest = latestRows?.[0]
  await orderModule.updateOrders([
    {
      id: order.id,
      metadata: {
        ...(latest?.metadata || order.metadata || {}),
        esim_qrcodes: JSON.stringify(
          data.qrcodes.map((q: any) => ({
            ...q,
            name: q?.name || "eSIM",
            src: normalizeQrSrc(q?.src),
          })),
        ),
        fulfillment_status: "fulfilled",
        fulfillment_error: "",
        microesim_topup_id: topupId,
      },
    },
  ])
  console.log(`[recover-topup] 發貨＋寄信完成 QR=${data.qrcodes.length}`)

  if (!order.metadata?.ezpay_invoice_number && amount >= 1) {
    const invoiceRes = await fetch(`${fulfillBase}/api/internal/issue-invoice`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        orderId: order.id,
        orderNo: orderNo.slice(0, 20),
        email: order.email,
        amount,
        items: [
          {
            name: productName,
            qty: 1,
            price: amount,
          },
        ],
      }),
    })
    const invoiceData = await invoiceRes.json().catch(() => ({}))
    if (invoiceRes.ok && invoiceData?.success && invoiceData?.invoiceNumber) {
      const { data: afterRows } = await query.graph({
        entity: "order",
        fields: ["id", "metadata"],
        filters: { id: [order.id] },
      })
      const after = afterRows?.[0]
      await orderModule.updateOrders([
        {
          id: order.id,
          metadata: {
            ...(after?.metadata || {}),
            ezpay_invoice_number: invoiceData.invoiceNumber,
            ezpay_invoice_random: invoiceData.randomNum || "",
            ezpay_invoice_at: invoiceData.createTime || new Date().toISOString(),
          },
        },
      ])
      console.log(`[recover-topup] 開票完成: ${invoiceData.invoiceNumber}`)
    } else if (!invoiceData?.skipped) {
      console.error(`[recover-topup] 開票失敗:`, invoiceData?.message || invoiceData)
    }
  }

  console.log("[recover-topup] 完成，請重整 thank-you")
}
