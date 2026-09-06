import { Modules } from "@medusajs/framework/utils"
import { linePayOrderNoToCartId } from "./linePayOrderNo"
import {
  resolveTwdAmount,
  sumLineItemsAmount,
  resolveOrderTotalDiscountSafe,
  ORDER_TOTALS_FIELDS,
} from "./orderAmount"
import { notifyPaymentCare } from "./appendPaymentCareNotify"

type QueryLike = {
  graph: (args: Record<string, unknown>) => Promise<{ data: any[] }>
}

/**
 * LINE Pay 未付款／確認失敗：從 cart（或舊 order）取 email 寄關懷信。
 */
export async function notifyLinePayCareFromOrderNo(opts: {
  query: QueryLike
  scope?: { resolve: (key: string) => unknown }
  orderNo: string
  reason: string
  message?: string
}): Promise<void> {
  const orderNo = String(opts.orderNo || "").trim()
  if (!orderNo) return

  const cartId = linePayOrderNoToCartId(orderNo)
  if (cartId) {
    try {
      const { data: carts } = await opts.query.graph({
        entity: "cart",
        // 含 items.*，否則 total 會是 0（見 ORDER_TOTALS_FIELDS）
        fields: ["id", "email", "metadata", ...ORDER_TOTALS_FIELDS],
        filters: { id: [cartId] },
      })
      const cart = carts?.[0]
      const email = String(cart?.email || "").trim()
      if (!email) return
      if (cart?.metadata?.payment_care_email_sent_at) return

      const amount =
        resolveTwdAmount(cart?.metadata?.linepay_amount) ||
        resolveTwdAmount(cart?.total, sumLineItemsAmount(cart?.items))

      await notifyPaymentCare({
        email,
        orderNo,
        amount,
        reason: opts.reason,
        message: opts.message || "",
        method: "linepay",
      })

      if (opts.scope) {
        try {
          const cartModule = opts.scope.resolve(Modules.CART) as {
            updateCarts: (
              data: Array<{ id: string; metadata?: Record<string, unknown> }>
            ) => Promise<unknown>
          }
          await cartModule.updateCarts([
            {
              id: cartId,
              metadata: {
                ...(cart.metadata || {}),
                payment_care_email_sent_at: new Date().toISOString(),
                payment_care_email_reason: String(opts.reason || "").slice(0, 120),
              },
            },
          ])
        } catch {
          /* ignore meta write */
        }
      }
      return
    } catch (e: any) {
      console.warn(
        "[notifyLinePayCareFromOrderNo] cart:",
        e?.message || e,
      )
    }
  }

  // 舊流程：orderNo = Medusa order id 去掉 order_ 前綴
  const orderId = orderNo.startsWith("order_") ? orderNo : `order_${orderNo}`
  try {
    const { data: orders } = await opts.query.graph({
      entity: "order",
      // 含 items.*，否則 total 會是 0（見 ORDER_TOTALS_FIELDS）
      fields: ["id", "email", "metadata", ...ORDER_TOTALS_FIELDS],
      filters: { id: [orderId] },
    })
    const order = orders?.[0]
    const email = String(order?.email || "").trim()
    if (!email) return
    if (order?.metadata?.payment_care_email_sent_at) return

    const amount =
      resolveTwdAmount(order?.metadata?.linepay_amount) ||
      resolveOrderTotalDiscountSafe(order)

    await notifyPaymentCare({
      email,
      orderNo,
      orderId: order.id,
      amount,
      reason: opts.reason,
      message: opts.message || "",
      method: "linepay",
    })

    if (opts.scope) {
      try {
        const orderModule = opts.scope.resolve("order") as {
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
              payment_care_email_reason: String(opts.reason || "").slice(0, 120),
            },
          },
        ])
      } catch {
        /* ignore */
      }
    }
  } catch (e: any) {
    console.warn(
      "[notifyLinePayCareFromOrderNo] order:",
      e?.message || e,
    )
  }
}
