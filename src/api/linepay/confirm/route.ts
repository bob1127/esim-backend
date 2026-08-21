import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import crypto from "crypto"

const LINEPAY_BASE = process.env.LINEPAY_API_BASE || "https://api-pay.line.me"

function signLinePay(
  channelSecret: string,
  apiPath: string,
  body: string,
  nonce: string
) {
  return crypto
    .createHmac("sha256", channelSecret)
    .update(channelSecret + apiPath + body + nonce)
    .digest("base64")
}

function normalizeQrSrc(raw: any): string {
  const str = String(raw || "")
  if (!str) return ""
  return str.startsWith("http") || str.startsWith("data:image/")
    ? str
    : `data:image/png;base64,${str}`
}

type LinePayConfirmBody = {
  transactionId?: string
  orderNo?: string
}

export async function POST(
  req: MedusaRequest<LinePayConfirmBody>,
  res: MedusaResponse
) {
  const channelId = process.env.LINEPAY_CHANNEL_ID
  const channelSecret = process.env.LINEPAY_CHANNEL_SECRET
  const storeUrl = (process.env.STORE_URL || "https://www.jeko-esim.com.tw").replace(/\/$/, "")
  const fulfillBase = process.env.FULFILLMENT_INTERNAL_URL
  const fulfillSecret = process.env.FULFILLMENT_INTERNAL_SECRET || ""
  const debugEnabled = String(req.headers["x-e2e-debug"] || "").trim() === "1" // local e2e only
  const debug: Record<string, any> = debugEnabled ? {} : {}

  if (!channelId || !channelSecret) {
    return res.status(503).json({ success: false, message: "LINE Pay 金鑰未設定" })
  }

  const body = (req.body || {}) as LinePayConfirmBody
  const queryParams = (req.query || {}) as Record<string, string | string[] | undefined>
  const txRaw = body.transactionId ?? queryParams.transactionId
  const orderNoRaw = body.orderNo ?? queryParams.orderNo
  const transactionId = String(Array.isArray(txRaw) ? txRaw[0] : txRaw || "").trim()
  const orderNo = String(Array.isArray(orderNoRaw) ? orderNoRaw[0] : orderNoRaw || "").trim()

  if (!transactionId || !orderNo) {
    return res.status(400).json({ success: false, message: "缺少 transactionId 或 orderNo" })
  }

  const orderId = `order_${orderNo}`

  try {
    const query = req.scope.resolve("query") as {
      graph: (args: Record<string, unknown>) => Promise<{ data: any[] }>
    }
    const orderModule = req.scope.resolve("order") as {
      updateOrders: (data: Array<{ id: string; metadata: Record<string, unknown> }>) => Promise<unknown>
    }

    const { data: orders } = await query.graph({
      entity: "order",
      fields: [
        "id",
        "email",
        "total",
        "metadata",
        "payment_status",
        "items.title",
        "items.product_title",
        "items.variant_sku",
        "items.quantity",
        "items.unit_price",
        "items.subtotal",
        "payment_collections.payment_sessions.id",
      ],
      filters: { id: [orderId] },
    })
    const order = orders?.[0]
    if (!order) {
      return res.status(404).json({ success: false, message: "找不到對應訂單" })
    }

    const amount = Math.max(Math.round(Number(order.total ?? 0)), 1)
    const confirmPath = `/v4/payments/${encodeURIComponent(transactionId)}/confirm`
    const confirmBody = JSON.stringify({ amount, currency: "TWD" })
    const nonce = crypto.randomUUID()
    const signature = signLinePay(channelSecret, confirmPath, confirmBody, nonce)

    const lineRes = await fetch(`${LINEPAY_BASE}${confirmPath}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-LINE-ChannelId": channelId,
        "X-LINE-Authorization-Nonce": nonce,
        "X-LINE-Authorization": signature,
      },
      body: confirmBody,
    })
    const lineData = await lineRes.json().catch(() => ({}))
    if (!lineRes.ok || lineData?.returnCode !== "0000") {
      return res.status(400).json({
        success: false,
        message: "LINE Pay confirm 失敗",
        detail: lineData,
      })
    }

    const alreadyPaid = !!order.metadata?.linepay_pay_time
    if (!alreadyPaid && order.payment_status !== "captured") {
      const sessionId = order.payment_collections?.[0]?.payment_sessions?.[0]?.id
      if (sessionId) {
        try {
          const paymentModule = req.scope.resolve("payment") as any
          const payment = await paymentModule.authorizePaymentSession(sessionId, {})
          if (payment?.id) {
            await paymentModule.capturePayment({
              payment_id: payment.id,
              amount: order.total,
            })
          }
        } catch (e) {
          console.error("[linepay-confirm] authorize/capture 失敗:", e)
        }
      }
    }

    await orderModule.updateOrders([
      {
        id: order.id,
        metadata: {
          ...(order.metadata || {}),
          linepay_order_no: orderNo,
          linepay_transaction_id: transactionId,
          linepay_pay_time: new Date().toISOString(),
        },
      },
    ])

    if (fulfillBase && fulfillSecret) {
      if (debugEnabled) {
        debug.fulfillBase = fulfillBase
        debug.fulfillSecretPresent = true
        debug.fulfillSecretLen = fulfillSecret.length
      }
      const lineItems = (order.items || []).map((it: any) => ({
        name: it.product_title || it.title,
        sku: it.variant_sku || "",
        quantity: it.quantity,
        unit_price:
          typeof it.unit_price === "number"
            ? it.unit_price
            : typeof it.subtotal === "number" && it.quantity
              ? Math.round(Number(it.subtotal) / Number(it.quantity))
              : undefined,
      }))

      if (!order.metadata?.esim_qrcodes) {
        try {
          const fulfillRes = await fetch(
            `${fulfillBase.replace(/\/$/, "")}/api/internal/fulfill-order`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Fulfillment-Secret": fulfillSecret,
              },
              body: JSON.stringify({
                orderId: order.id,
                email: order.email,
                items: lineItems.map((it: any) => ({
                  name: it.name,
                  sku: it.sku,
                  quantity: it.quantity,
                })),
              }),
            }
          )
          const fulfillData = await fulfillRes.json().catch(() => ({}))
          if (debugEnabled) {
            debug.fulfillResStatus = fulfillRes.status
            debug.fulfillOk = fulfillRes.ok
            debug.fulfillQrcodesCount = Array.isArray(fulfillData?.qrcodes)
              ? fulfillData.qrcodes.length
              : 0
          }
          if (fulfillRes.ok && Array.isArray(fulfillData?.qrcodes) && fulfillData.qrcodes.length) {
            await orderModule.updateOrders([
              {
                id: order.id,
                metadata: {
                  ...(order.metadata || {}),
                  esim_qrcodes: JSON.stringify(
                    fulfillData.qrcodes.map((q: any) => ({
                      name: q?.name || "eSIM",
                      src: normalizeQrSrc(q?.src),
                    }))
                  ),
                },
              },
            ])
          }
        } catch (e) {
          console.error("[linepay-confirm] fulfill 失敗:", e)
        }
      }

      if (!order.metadata?.ezpay_invoice_number) {
        try {
          const invoiceRes = await fetch(
            `${fulfillBase.replace(/\/$/, "")}/api/internal/issue-invoice`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Fulfillment-Secret": fulfillSecret,
              },
              body: JSON.stringify({
                orderId: order.id,
                orderNo: orderNo.slice(0, 20),
                email: order.email,
                amount,
                items: lineItems.map((it: any) => ({
                  name: it.name,
                  qty: it.quantity || 1,
                  price:
                    it.unit_price != null
                      ? it.unit_price
                      : Math.round(amount / Math.max(1, lineItems.length)),
                })),
              }),
            }
          )
          const invoiceData = await invoiceRes.json().catch(() => ({}))
          if (debugEnabled) {
            debug.issueInvoiceResStatus = invoiceRes.status
            debug.issueInvoiceOk = invoiceRes.ok
            debug.invoiceNumberPresent =
              typeof invoiceData?.invoiceNumber === "string" ? true : false
          }
          if (invoiceRes.ok && invoiceData?.success && invoiceData?.invoiceNumber) {
            await orderModule.updateOrders([
              {
                id: order.id,
                metadata: {
                  ...(order.metadata || {}),
                  ezpay_invoice_number: invoiceData.invoiceNumber,
                  ezpay_invoice_random: invoiceData.randomNum || "",
                  ezpay_invoice_at: invoiceData.createTime || new Date().toISOString(),
                },
              },
            ])
          }
        } catch (e) {
          console.error("[linepay-confirm] issue-invoice 失敗:", e)
        }
      }
    }

    return res.status(200).json({
      success: true,
      redirectUrl: `${storeUrl}/thank-you?status=success&method=linepay&orderNo=${encodeURIComponent(orderNo)}`,
      ...(debugEnabled ? { debug } : {}),
    })
  } catch (error: any) {
    console.error("[linepay-confirm] error:", error?.message || error)
    return res.status(500).json({
      success: false,
      message: error?.message || "LINE Pay 付款確認失敗",
      redirectUrl: `${storeUrl}/thank-you?status=error&method=linepay`,
      ...(debugEnabled ? { debug } : {}),
    })
  }
}
