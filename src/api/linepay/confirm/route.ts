import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import crypto from "crypto"
import {
  resolveTwdAmount,
  sumLineItemsAmount,
  loadOrderPayableAmount,
  verifyPaymentAmount,
} from "../../../lib/orderAmount"
import {
  extractJsonStringField,
  storeLinePayTxId,
} from "../../../lib/linePayIds"
import { upsertPartnerOrderToSupabase } from "../../../lib/partnerOrderSync"
import { appendAccountingSheet, buildAccountingPayload } from "../../../lib/appendAccountingSheet"

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

/** 付款已入帳後：背景發貨／開票，不擋 confirm → thank-you */
function scheduleAfterResponse(task: () => Promise<void>) {
  const run = () =>
    task().catch((e) =>
      console.error("[linepay-confirm] 背景任務失敗:", e?.message || e)
    )
  try {
    // Vercel / 部分 runtime 提供 waitUntil，避免回傳後被凍結
    const resAny = globalThis as any
    if (typeof resAny?.WaitUntil === "function") {
      resAny.WaitUntil(run())
      return
    }
  } catch {
    /* ignore */
  }
  void run()
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
        "items.metadata",
        "payment_collections.payment_sessions.id",
      ],
      filters: { id: [orderId] },
    })
    const order = orders?.[0]
    if (!order) {
      return res.status(404).json({ success: false, message: "找不到對應訂單" })
    }

    // 金額一律由 DB 重新計算（絕不信任前端／query 參數，也不做 1 元兜底）
    const expected =
      resolveTwdAmount(order.total, sumLineItemsAmount(order.items)) ||
      (await loadOrderPayableAmount(req.scope, order.id, 0))
    const reserved = resolveTwdAmount(order.metadata?.linepay_amount)
    const amountError = verifyPaymentAmount({ expected, reserved })
    if (amountError) {
      console.error(`[linepay-confirm] ${amountError}（訂單 ${order.id}），已拒絕請款`)
      return res.status(409).json({
        success: false,
        message: `金額核對失敗，已拒絕請款：${amountError}`,
      })
    }

    // 必須用「request 時寫入 LINE 的金額」請款；TWD 不可有小數（LINE 1124 scale）
    // reserved 缺漏時才退回 expected（舊單備援）
    const amount = Math.round(Number(reserved > 0 ? reserved : expected))
    if (!Number.isFinite(amount) || amount < 1 || !Number.isInteger(amount)) {
      return res.status(409).json({
        success: false,
        message: `金額異常，已拒絕請款（amount=${amount}）`,
      })
    }

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
    // 用原文抽取 transactionId／orderId，避免 19 位整數被 JSON.parse 成 Number 後精度遺失
    const lineRaw = await lineRes.text()
    const lineData = (() => {
      try {
        return JSON.parse(lineRaw)
      } catch {
        return {}
      }
    })() as Record<string, any>
    if (!lineRes.ok || lineData?.returnCode !== "0000") {
      console.error("[linepay-confirm] LINE 拒絕請款", {
        orderId: order.id,
        orderNo,
        transactionId,
        amount,
        expected,
        reserved,
        confirmBody,
        returnCode: lineData?.returnCode,
        returnMessage: lineData?.returnMessage,
      })
      return res.status(400).json({
        success: false,
        message: "LINE Pay confirm 失敗",
        detail: lineData,
      })
    }

    // 防偽核對：以 LINE Pay 回傳的 orderId 綁定訂單（比 metadata 裡的 tx 更可靠；
    // metadata 曾因 19 位整數精度問題誤判「交易編號不符」）
    const confirmedOrderId = extractJsonStringField(lineRaw, "orderId") ||
      String(lineData?.info?.orderId || "").trim()
    if (confirmedOrderId && confirmedOrderId !== orderNo) {
      console.error(
        `[linepay-confirm] LINE Pay orderId 不符: 訂單=${order.id} expected=${orderNo} got=${confirmedOrderId}`
      )
      return res.status(409).json({
        success: false,
        message: "付款訂單編號與系統訂單不符，已拒絕入帳",
      })
    }

    const confirmedTxId =
      extractJsonStringField(lineRaw, "transactionId") || transactionId

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
              amount,
            })
          }
        } catch (e) {
          console.error("[linepay-confirm] authorize/capture 失敗:", e)
        }
      }
    }

    const paidMeta = {
      ...(order.metadata || {}),
      linepay_order_no: orderNo,
      linepay_transaction_id: storeLinePayTxId(confirmedTxId),
      linepay_pay_time: new Date().toISOString(),
      linepay_amount: amount,
    }

    await orderModule.updateOrders([
      {
        id: order.id,
        metadata: paidMeta,
      },
    ])

    if (!alreadyPaid) {
      void appendAccountingSheet(
        buildAccountingPayload(order, {
          amount,
          paymentProvider: "linepay",
          payTime: paidMeta.linepay_pay_time as string,
          tradeNo: String(confirmedTxId || orderNo),
        }),
      )
    }

    // 夥伴店訂單 → 付款成功後把分潤列寫回 Supabase（冪等 upsert）
    if (order.metadata?.is_partner_order) {
      try {
        await upsertPartnerOrderToSupabase({
          order,
          merchantOrderNo: orderNo,
          totalAmount: amount,
          payType: "LINEPAY",
        })
      } catch (syncErr: any) {
        console.error(
          "[linepay-confirm] 夥伴訂單同步 Supabase 失敗:",
          syncErr?.message || syncErr,
        )
      }
    }

    const needFulfill = !order.metadata?.esim_qrcodes
    const needInvoice = !order.metadata?.ezpay_invoice_number

    if (fulfillBase && fulfillSecret && (needFulfill || needInvoice)) {
      if (debugEnabled) {
        debug.fulfillBase = fulfillBase
        debug.fulfillSecretPresent = true
        debug.fulfillSecretLen = fulfillSecret.length
        debug.fulfillScheduled = needFulfill
        debug.invoiceScheduled = needInvoice
      }

      const lineItems = (order.items || []).map((it: any) => ({
        name: it.product_title || it.title,
        sku:
          it.variant_sku ||
          it.metadata?.esim_plan_id ||
          it.metadata?.plan_id ||
          it.metadata?.planId ||
          "",
        planId:
          it.metadata?.esim_plan_id ||
          it.metadata?.plan_id ||
          it.metadata?.planId ||
          "",
        quantity: it.quantity,
        unit_price:
          typeof it.unit_price === "number"
            ? it.unit_price
            : typeof it.subtotal === "number" && it.quantity
              ? Math.round(Number(it.subtotal) / Number(it.quantity))
              : undefined,
      }))

      const base = fulfillBase.replace(/\/$/, "")
      const headers = {
        "Content-Type": "application/json",
        "X-Fulfillment-Secret": fulfillSecret,
      }

      // 入帳後立刻回 thank-you；發貨／開票背景跑（thank-you 會輪詢 QR）
      scheduleAfterResponse(async () => {
        const patchMeta = async (extra: Record<string, unknown>) => {
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
                ...(latest?.metadata || paidMeta),
                ...extra,
              },
            },
          ])
        }

        if (needFulfill) {
          try {
            const fulfillRes = await fetch(`${base}/api/internal/fulfill-order`, {
              method: "POST",
              headers,
              body: JSON.stringify({
                orderId: order.id,
                email: order.email,
                items: lineItems.map((it: any) => ({
                  name: it.name,
                  sku: it.sku,
                  planId: it.planId,
                  quantity: it.quantity,
                })),
              }),
            })
            const fulfillData = await fulfillRes.json().catch(() => ({}))
            if (
              fulfillRes.ok &&
              Array.isArray(fulfillData?.qrcodes) &&
              fulfillData.qrcodes.length
            ) {
              await patchMeta({
                esim_qrcodes: JSON.stringify(
                  fulfillData.qrcodes.map((q: any) => ({
                    ...q,
                    name: q?.name || "eSIM",
                    src: normalizeQrSrc(q?.src),
                  }))
                ),
                fulfillment_status: "fulfilled",
                fulfillment_error: "",
              })
              console.log(`[linepay-confirm] 背景發貨完成: ${order.id}`)
            } else {
              const msg = String(fulfillData?.message || `HTTP ${fulfillRes.status}`)
              await patchMeta({
                fulfillment_status: "failed",
                fulfillment_error: msg.slice(0, 500),
              })
              console.error(`[linepay-confirm] 背景發貨失敗: ${order.id}`, msg)
            }
          } catch (e: any) {
            await patchMeta({
              fulfillment_status: "failed",
              fulfillment_error: String(e?.message || e).slice(0, 500),
            }).catch(() => {})
            console.error("[linepay-confirm] 背景 fulfill 例外:", e?.message || e)
          }
        }

        if (needInvoice) {
          try {
            const invoiceRes = await fetch(`${base}/api/internal/issue-invoice`, {
              method: "POST",
              headers,
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
            })
            const invoiceData = await invoiceRes.json().catch(() => ({}))
            if (invoiceRes.ok && invoiceData?.success && invoiceData?.invoiceNumber) {
              await patchMeta({
                ezpay_invoice_number: invoiceData.invoiceNumber,
                ezpay_invoice_random: invoiceData.randomNum || "",
                ezpay_invoice_at:
                  invoiceData.createTime || new Date().toISOString(),
              })
              console.log(`[linepay-confirm] 背景開票完成: ${order.id}`)
            } else if (!invoiceData?.skipped) {
              console.error(
                `[linepay-confirm] 背景開票失敗: ${order.id}`,
                invoiceData?.message || invoiceData
              )
            }
          } catch (e: any) {
            console.error("[linepay-confirm] 背景 invoice 例外:", e?.message || e)
          }
        }
      })
    } else if (needFulfill || needInvoice) {
      console.warn(
        `[linepay-confirm] 略過發貨／開票（訂單 ${order.id}）：` +
          `需在 Railway 設定 FULFILLMENT_INTERNAL_URL=https://www.jeko-esim.com.tw` +
          ` 與 FULFILLMENT_INTERNAL_SECRET（須與 Vercel 前台相同）。` +
          ` 目前 url=${fulfillBase ? "有" : "無"} secret=${fulfillSecret ? "有" : "無"}`
      )
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
