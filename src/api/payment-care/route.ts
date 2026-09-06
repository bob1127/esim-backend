import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { notifyLinePayCareFromOrderNo } from "../../lib/notifyLinePayPaymentCare"
import { notifyPaymentCare } from "../../lib/appendPaymentCareNotify"
import {
  resolveTwdAmount,
  resolveOrderTotalDiscountSafe,
  ORDER_TOTALS_FIELDS,
} from "../../lib/orderAmount"

type Body = {
  orderNo?: string
  reason?: string
  method?: string
  message?: string
}

/**
 * 前台放棄／失敗頁可呼叫：只帶 orderNo，由後端查 email 後寄關懷信。
 * POST { orderNo, reason?, method? }
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const body = (req.body || {}) as Body
  const orderNo = String(body.orderNo || "").trim()
  const reason = String(body.reason || "payment_unpaid").trim()
  const method = String(body.method || "").trim().toLowerCase()
  const message = String(body.message || "").trim()

  if (!orderNo) {
    return res.status(400).json({ success: false, message: "缺少 orderNo" })
  }

  try {
    const query = req.scope.resolve("query") as {
      graph: (args: Record<string, unknown>) => Promise<{ data: any[] }>
    }

    if (method === "linepay" || /^C/i.test(orderNo)) {
      await notifyLinePayCareFromOrderNo({
        query,
        scope: req.scope,
        orderNo,
        reason: reason || "linepay_unpaid",
        message,
      })
      return res.status(200).json({ success: true })
    }

    // 藍新：orderNo 為 MerchantOrderNo（通常等同 order_ 後綴）
    const orderId = orderNo.startsWith("order_") ? orderNo : `order_${orderNo}`
    const { data: orders } = await query.graph({
      entity: "order",
      fields: [
        "id",
        "email",
        "payment_status",
        "metadata",
        // 含 items.*，否則 total 會是 0（見 ORDER_TOTALS_FIELDS）
        ...ORDER_TOTALS_FIELDS,
      ],
      filters: { id: [orderId] },
    })
    const order = orders?.[0]
    if (!order?.email) {
      return res.status(200).json({ success: true, skipped: true, reason: "no_order_or_email" })
    }
    if (
      order.payment_status === "captured" ||
      order.metadata?.newebpay_pay_time ||
      order.metadata?.linepay_pay_time
    ) {
      return res.status(200).json({ success: true, skipped: true, reason: "already_paid" })
    }
    if (order.metadata?.payment_care_email_sent_at) {
      return res.status(200).json({ success: true, skipped: true, reason: "already_sent" })
    }

    const amount =
      resolveTwdAmount(order.metadata?.newebpay_amount) ||
      resolveOrderTotalDiscountSafe(order)

    await notifyPaymentCare({
      email: order.email,
      orderNo: orderNo.replace(/^order_/, ""),
      orderId: order.id,
      amount,
      reason: reason || "newebpay_unpaid",
      message,
      method: "newebpay",
    })

    try {
      const orderModule = req.scope.resolve("order") as {
        updateOrders: (
          data: Array<{ id: string; metadata: Record<string, unknown> }>
        ) => Promise<unknown>
      }
      await orderModule.updateOrders([
        {
          id: order.id,
          metadata: {
            ...(order.metadata || {}),
            payment_care_email_sent_at: new Date().toISOString(),
            payment_care_email_reason: reason.slice(0, 120),
          },
        },
      ])
    } catch {
      /* ignore */
    }

    return res.status(200).json({ success: true })
  } catch (e: any) {
    console.error("[payment-care]", e?.message || e)
    return res.status(500).json({
      success: false,
      message: e?.message || "寄信失敗",
    })
  }
}
