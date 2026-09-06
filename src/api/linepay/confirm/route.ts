import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import {
  resolveTwdAmount,
  sumLineItemsAmount,
} from "../../../lib/orderAmount"
import {
  storeLinePayTxId,
} from "../../../lib/linePayIds"
import { upsertPartnerOrderToSupabase } from "../../../lib/partnerOrderSync"
import { resolveOrderAfterLinePayConfirm } from "../../../lib/linePayConfirmResolve"
import {
  upsertReferralOrderToSupabase,
  buildReferralOrderMetadata,
} from "../../../lib/referralOrderSync"
import { appendAccountingSheet, buildAccountingPayload } from "../../../lib/appendAccountingSheet"
import { notifyAdminNewOrder } from "../../../lib/appendAdminOrderNotify"
import {
  fulfillPaidOrderWithRetry,
  stringifyEsimQrcodes,
} from "../../../lib/orderFulfillment"
import { notifyLinePayCareFromOrderNo } from "../../../lib/notifyLinePayPaymentCare"

const LINEPAY_BASE = process.env.LINEPAY_API_BASE || "https://api-pay.line.me"

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

  const backendUrl = (process.env.MEDUSA_BACKEND_URL || "http://localhost:9000").replace(
    /\/$/,
    ""
  )
  const publishableKey =
    String(req.headers["x-publishable-api-key"] || "").trim() ||
    process.env.MEDUSA_PUBLISHABLE_API_KEY ||
    process.env.PUBLISHABLE_API_KEY ||
    ""

  try {
    const query = req.scope.resolve("query") as {
      graph: (args: Record<string, unknown>) => Promise<{ data: any[] }>
    }
    const orderModule = req.scope.resolve("order") as {
      updateOrders: (data: Array<{ id: string; metadata: Record<string, unknown> }>) => Promise<unknown>
    }

    // LINE Pay：新流程先請款再建單；舊未付款單仍相容。藍新 ATM／匯款不走此路徑。
    const resolved = await resolveOrderAfterLinePayConfirm({
      scope: req.scope,
      orderNo,
      transactionId,
      channelId,
      channelSecret,
      publishableKey,
      backendUrl,
    })
    if (!resolved.ok) {
      scheduleAfterResponse(async () => {
        try {
          await notifyLinePayCareFromOrderNo({
            query,
            scope: req.scope,
            orderNo,
            reason: "linepay_confirm_fail",
            message: resolved.message || "",
          })
        } catch (e: any) {
          console.warn(
            "[linepay-confirm] care email:",
            e?.message || e,
          )
        }
      })
      return res.status(resolved.status).json({
        success: false,
        message: resolved.message,
        ...(resolved.detail !== undefined ? { detail: resolved.detail } : {}),
      })
    }

    const { order, amount, confirmedTxId, alreadyPaid } = resolved
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

    /* 優惠連結（referral）訂單 → 伺服器端重算分潤後寫回 Supabase。
       與夥伴店互斥：夥伴店的分潤在結帳時已簽章寫入 metadata，優惠連結是主站同價
       訂單，分潤要依 partners.referral_rate／商品電信商趴數重算。
       同步失敗不影響發貨；confirm 重試會再算一次（medusa_order_id 冪等）。 */
    let referralMeta: Record<string, unknown> = {}
    if (!order.metadata?.is_partner_order && order.metadata?.jeko_referral_code) {
      try {
        const referral = await upsertReferralOrderToSupabase({
          order,
          merchantOrderNo: orderNo,
          totalAmount: amount,
          payType: "LINEPAY",
          paymentProvider: "linepay",
          query,
        })
        referralMeta = buildReferralOrderMetadata(referral)
        if (referral.ok && !referral.skipped) {
          console.log(
            `[linepay-confirm] 優惠連結分潤已同步: partner=${referral.partnerId} 分潤=${referral.partnerProfit} 成本=${referral.b2bCost}`,
          )
        }
      } catch (refErr: any) {
        console.error(
          "[linepay-confirm] 優惠連結訂單同步 Supabase 失敗:",
          refErr?.message || refErr,
        )
      }
    }

    const paidMeta = {
      ...(order.metadata || {}),
      ...referralMeta,
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
      const accountingPayload = buildAccountingPayload(order, {
        amount,
        paymentProvider: "linepay",
        payTime: paidMeta.linepay_pay_time as string,
        tradeNo: String(confirmedTxId || orderNo),
      })
      void appendAccountingSheet(accountingPayload)
      void notifyAdminNewOrder(accountingPayload)
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
            await patchMeta({ fulfillment_status: "processing" })
            const existingTopupIds = (() => {
              try {
                const raw = paidMeta?.fulfillment_topup_ids
                const parsed =
                  typeof raw === "string" ? JSON.parse(raw) : raw
                return Array.isArray(parsed) ? parsed : []
              } catch {
                return []
              }
            })()

            const result = await fulfillPaidOrderWithRetry({
              fulfillBase: base,
              fulfillSecret,
              orderId: order.id,
              email: order.email,
              items: lineItems.map((it: any) => ({
                name: it.name,
                sku: it.sku,
                planId: it.planId,
                quantity: it.quantity,
              })),
              existingTopupIds,
              logPrefix: `[linepay-confirm:${order.id}]`,
            })

            if (result.topupIds.length) {
              await patchMeta({
                fulfillment_topup_ids: JSON.stringify(result.topupIds),
              })
            }

            if (result.ok && result.qrcodes.length) {
              await patchMeta({
                esim_qrcodes: stringifyEsimQrcodes(result.qrcodes),
                fulfillment_status: "fulfilled",
                fulfillment_error: "",
              })
              console.log(
                `[linepay-confirm] 背景發貨完成: ${order.id} attempts=${result.attempts}`,
              )
            } else {
              await patchMeta({
                fulfillment_status: "failed",
                fulfillment_error: String(result.message || "fulfill failed").slice(
                  0,
                  500,
                ),
              })
              console.error(
                `[linepay-confirm] 背景發貨失敗（已重試）: ${order.id}`,
                result.message,
              )
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
            if (!Number(amount) || Number(amount) < 1) {
              // 金額算不出來就別送 ezPay（會被擋成 400，客人拿不到發票也查不到原因）
              throw new Error(`金額無效（amount=${amount}）`)
            }
            const invoiceRes = await fetch(`${base}/api/internal/issue-invoice`, {
              method: "POST",
              headers,
              body: JSON.stringify({
                orderId: order.id,
                orderNo: orderNo.slice(0, 20),
                email: order.email,
                amount,
                buyerName:
                  (order.metadata?.buyer_name as string) ||
                  order.shipping_address?.first_name ||
                  undefined,
                buyerUBN: (order.metadata?.buyer_ubn as string) || undefined,
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
                ezpay_invoice_error: "",
              })
              console.log(`[linepay-confirm] 背景開票完成: ${order.id}`)
            } else if (!invoiceData?.skipped) {
              const errMsg = String(
                invoiceData?.message || invoiceData || `HTTP ${invoiceRes.status}`
              ).slice(0, 500)
              await patchMeta({ ezpay_invoice_error: errMsg }).catch(() => {})
              console.error(
                `[linepay-confirm] 背景開票失敗: ${order.id}`,
                errMsg
              )
            }
          } catch (e: any) {
            await patchMeta({
              ezpay_invoice_error: String(e?.message || e).slice(0, 500),
            }).catch(() => {})
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
      redirectUrl: `${storeUrl}/thank-you?status=success&method=linepay&orderNo=${encodeURIComponent(String(order.id || "").replace(/^order_/, "") || orderNo)}`,
      ...(debugEnabled ? { debug } : {}),
    })
  } catch (error: any) {
    console.error("[linepay-confirm] error:", error?.message || error)
    scheduleAfterResponse(async () => {
      try {
        const query = req.scope.resolve("query") as {
          graph: (args: Record<string, unknown>) => Promise<{ data: any[] }>
        }
        await notifyLinePayCareFromOrderNo({
          query,
          scope: req.scope,
          orderNo,
          reason: "linepay_confirm_error",
          message: error?.message || "LINE Pay 付款確認失敗",
        })
      } catch {
        /* ignore */
      }
    })
    return res.status(500).json({
      success: false,
      message: error?.message || "LINE Pay 付款確認失敗",
      redirectUrl: `${storeUrl}/thank-you?status=error&method=linepay`,
      ...(debugEnabled ? { debug } : {}),
    })
  }
}
