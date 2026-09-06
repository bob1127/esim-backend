/**
 * 藍新已扣款但 notify 405 漏接 → 補 metadata／capture／發貨／開票／管理員通知
 *
 *   HOME=/tmp/medusa-home \
 *   FULFILLMENT_INTERNAL_URL=http://localhost:3000 \
 *   npx medusa exec ./src/scripts/recover-paid-missed-notify.ts \
 *   01M1RCBE7ADC9PG6FRFZ92WDQH 28090516535487709 "2026-09-05 16:53:54" CREDIT
 */
import { ExecArgs } from "@medusajs/framework/types"
import {
  fulfillPaidOrderWithRetry,
  stringifyEsimQrcodes,
} from "../lib/orderFulfillment"
import { ORDER_TOTALS_FIELDS } from "../lib/orderAmount"
import { notifyAdminNewOrder } from "../lib/appendAdminOrderNotify"
import { appendAccountingSheet, buildAccountingPayload } from "../lib/appendAccountingSheet"

function resolveOrderId(raw: string): string {
  const s = String(raw || "").trim()
  if (!s) return ""
  return s.startsWith("order_") ? s : `order_${s}`
}

export default async function recoverPaidMissedNotify({
  container,
  args,
}: ExecArgs) {
  const orderId = resolveOrderId(String(args?.[0] || ""))
  const tradeNo = String(args?.[1] || "").trim()
  const payTime = String(args?.[2] || new Date().toISOString()).trim()
  const payType = String(args?.[3] || "CREDIT").trim().toUpperCase()

  if (!orderId || !tradeNo) {
    throw new Error(
      "用法: <orderNo> <TradeNo> [payTime] [PaymentType]  例: 01M1RCBE7A… 28090516535487709",
    )
  }

  const fulfillBase = (process.env.FULFILLMENT_INTERNAL_URL || "").replace(
    /\/$/,
    "",
  )
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
      "status",
      "payment_status",
      "metadata",
      // items.* 不可省：少了它 total 會變 0（見 lib/orderAmount ORDER_TOTALS_FIELDS）
      ...ORDER_TOTALS_FIELDS,
      "items.title",
      "items.product_title",
      "items.variant_sku",
      "items.quantity",
      "items.unit_price",
      "items.subtotal",
      "items.metadata",
      "items.variant.metadata",
      "payment_collections.payment_sessions.id",
      "payment_collections.payments.id",
      "payment_collections.payments.captured_at",
      "payment_collections.status",
    ],
    filters: { id: [orderId] },
  })
  const order = orders?.[0]
  if (!order) throw new Error(`找不到訂單 ${orderId}`)

  const merchantOrderNo = String(order.id).replace(/^order_/, "")
  const expected = Math.round(
    Number(
      order.metadata?.newebpay_amount ||
        order.total ||
        0,
    ),
  )
  console.log(
    `[recover] order=${order.id} email=${order.email} amount=${expected} payment_status=${order.payment_status}`,
  )

  // Capture
  if (!order.metadata?.newebpay_pay_time && order.payment_status !== "captured") {
    const sessionId =
      order.payment_collections?.[0]?.payment_sessions?.[0]?.id
    if (sessionId) {
      try {
        const paymentModule = container.resolve("payment") as any
        const payment = await paymentModule.authorizePaymentSession(sessionId, {})
        if (payment?.id) {
          await paymentModule.capturePayment({
            payment_id: payment.id,
            amount: expected,
          })
          console.log(`[recover] captured payment ${payment.id}`)
        }
      } catch (e: any) {
        console.error(`[recover] capture 失敗（續行發貨）:`, e?.message || e)
      }
    } else {
      console.warn("[recover] 無 payment session，略過 capture")
    }
  }

  await orderModule.updateOrders([
    {
      id: order.id,
      metadata: {
        ...(order.metadata || {}),
        newebpay_merchant_order_no: merchantOrderNo,
        newebpay_payment_type: payType,
        newebpay_trade_no: tradeNo,
        newebpay_pay_time: payTime,
        newebpay_amount: expected,
        newebpay_notify_recovered_at: new Date().toISOString(),
        newebpay_notify_recover_note:
          "manual recover after Vercel 405 (notify URL hit static index.html)",
      },
    },
  ])
  console.log(`[recover] metadata pay_time/trade_no written`)

  const accountingPayload = buildAccountingPayload(order, {
    amount: expected,
    paymentProvider: "newebpay",
    payTime,
    tradeNo,
  })
  try {
    await appendAccountingSheet(accountingPayload)
    console.log("[recover] accounting sheet ok")
  } catch (e: any) {
    console.warn("[recover] accounting sheet:", e?.message || e)
  }
  try {
    await notifyAdminNewOrder(accountingPayload)
    console.log("[recover] admin notify ok")
  } catch (e: any) {
    console.warn("[recover] admin notify:", e?.message || e)
  }

  // Fulfill + invoice (same as notify background)
  const { data: latestRows } = await query.graph({
    entity: "order",
    fields: [
      "id",
      "email",
      "metadata",
      // items.* 不可省：少了它 total 會變 0（見 lib/orderAmount ORDER_TOTALS_FIELDS）
      ...ORDER_TOTALS_FIELDS,
      "items.title",
      "items.product_title",
      "items.variant_sku",
      "items.metadata",
      "items.variant.metadata",
    ],
    filters: { id: [order.id] },
  })
  const latest = latestRows?.[0] || order
  const hasQrcodes = !!latest.metadata?.esim_qrcodes
  const hasInvoice = !!latest.metadata?.ezpay_invoice_number

  if (!hasQrcodes) {
    const items: Array<{
      name: string
      sku: string
      planId: string
      quantity: number
    }> = (latest.items || []).map((it: any) => {
      const qty = Math.max(1, Math.round(Number(it.quantity) || 1))
      const varMeta = it.variant?.metadata || {}
      return {
        name: it.product_title || it.title || "eSIM",
        sku: it.variant_sku || varMeta.plan_id || "",
        planId:
          String(
            varMeta.plan_id ||
              it.metadata?.esim_plan_id ||
              it.metadata?.plan_id ||
              "",
          ),
        quantity: qty,
      }
    })
    const result = await fulfillPaidOrderWithRetry({
      fulfillBase,
      fulfillSecret,
      orderId: order.id,
      email: latest.email,
      items,
      attempts: 3,
      delaysMs: [0, 5000, 15000],
      logPrefix: "[recover]",
    })
    if (!result.ok || !result.qrcodes?.length) {
      throw new Error(
        `發貨失敗: ${result.message || "no qrcodes"} attempts=${result.attempts}`,
      )
    }
    await orderModule.updateOrders([
      {
        id: order.id,
        metadata: {
          ...(latest.metadata || {}),
          esim_qrcodes: stringifyEsimQrcodes(result.qrcodes),
          fulfillment_status: "fulfilled",
          fulfillment_error: "",
          esim_fulfill_at: new Date().toISOString(),
          esim_topup_ids: JSON.stringify(result.topupIds || []),
        },
      },
    ])
    console.log(`[recover] 發貨完成 QR=${result.qrcodes.length}`)
  } else {
    console.log("[recover] 已有 QR，略過發貨")
  }

  if (!hasInvoice && expected >= 1) {
    const orderNo = merchantOrderNo.slice(0, 20)
    const items = (latest.items || []).map((it: any) => {
      const qty = Math.max(1, Math.round(Number(it.quantity) || 1))
      const unit =
        typeof it.unit_price === "number"
          ? Math.round(it.unit_price)
          : Math.round(expected / qty)
      return {
        name: it.product_title || it.title || "eSIM",
        qty,
        price: unit,
      }
    })
    const invoiceRes = await fetch(`${fulfillBase}/api/internal/issue-invoice`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Fulfillment-Secret": fulfillSecret,
      },
      body: JSON.stringify({
        orderId: order.id,
        orderNo,
        email: latest.email,
        amount: expected,
        items,
      }),
    })
    const invoiceData = await invoiceRes.json().catch(() => ({}))
    if (invoiceRes.ok && invoiceData?.success && invoiceData?.invoiceNumber) {
      const { data: rows2 } = await query.graph({
        entity: "order",
        fields: ["id", "metadata"],
        filters: { id: [order.id] },
      })
      await orderModule.updateOrders([
        {
          id: order.id,
          metadata: {
            ...(rows2?.[0]?.metadata || latest.metadata || {}),
            ezpay_invoice_number: invoiceData.invoiceNumber,
            ezpay_invoice_random: invoiceData.randomNum || "",
            ezpay_invoice_at:
              invoiceData.createTime || new Date().toISOString(),
          },
        },
      ])
      console.log(`[recover] 發票: ${invoiceData.invoiceNumber}`)
    } else {
      console.error(
        "[recover] 開票失敗:",
        invoiceData?.message || invoiceData || `HTTP ${invoiceRes.status}`,
      )
    }
  } else if (hasInvoice) {
    console.log(`[recover] 已有發票 ${latest.metadata?.ezpay_invoice_number}`)
  }

  console.log("[recover] DONE")
}
