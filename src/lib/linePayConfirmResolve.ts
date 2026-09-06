import type { MedusaContainer } from "@medusajs/framework/types"
import {
  resolveTwdAmount,
  sumLineItemsAmount,
  loadOrderPayableAmount,
  verifyPaymentAmount,
  resolveOrderTotalDiscountSafe,
  ORDER_TOTALS_FIELDS,
} from "./orderAmount"
import {
  extractJsonStringField,
  storeLinePayTxId,
} from "./linePayIds"
import { linePayOrderNoToCartId } from "./linePayOrderNo"
import { completeMedusaOrderForLinePay } from "./linePayCompleteCart"
import crypto from "crypto"

const LINEPAY_BASE = process.env.LINEPAY_API_BASE || "https://api-pay.line.me"

const ORDER_FIELDS = [
  "id",
  "display_id",
  "email",
  "metadata",
  "payment_status",
  // 金額欄位（含 items.*）缺一不可，否則 total／items.total 會全變 0
  ...ORDER_TOTALS_FIELDS,
  // 開票買受人姓名
  "shipping_address.first_name",
  "shipping_address.last_name",
  "items.title",
  "items.product_title",
  "items.product_id",
  "items.variant_sku",
  "items.quantity",
  "items.unit_price",
  "items.subtotal",
  "items.total",
  "items.metadata",
  "items.variant.id",
  "items.variant.sku",
  "items.variant.metadata",
  "payment_collections.payment_sessions.id",
]

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

async function storeFetch(
  backendUrl: string,
  path: string,
  headers: Record<string, string>,
  init?: RequestInit
) {
  const response = await fetch(`${backendUrl}${path}`, {
    ...init,
    headers: { ...headers, ...(init?.headers as Record<string, string>) },
  })
  const data = await response.json().catch(() => ({}))
  return { response, data }
}

async function confirmWithLinePay(opts: {
  channelId: string
  channelSecret: string
  transactionId: string
  amount: number
  orderNo: string
  logCtx: Record<string, unknown>
}) {
  const { channelId, channelSecret, transactionId, amount, orderNo, logCtx } =
    opts
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
      ...logCtx,
      orderNo,
      transactionId,
      amount,
      returnCode: lineData?.returnCode,
      returnMessage: lineData?.returnMessage,
    })
    return {
      ok: false as const,
      status: 400,
      message: "LINE Pay confirm 失敗",
      detail: lineData,
    }
  }

  const confirmedOrderId =
    extractJsonStringField(lineRaw, "orderId") ||
    String(lineData?.info?.orderId || "").trim()
  if (confirmedOrderId && confirmedOrderId !== orderNo) {
    return {
      ok: false as const,
      status: 409,
      message: "付款訂單編號與系統不符，已拒絕入帳",
    }
  }

  const confirmedTxId =
    extractJsonStringField(lineRaw, "transactionId") || transactionId

  return { ok: true as const, confirmedTxId, amount }
}

export type ResolveLinePayResult =
  | {
      ok: true
      order: any
      amount: number
      confirmedTxId: string
      alreadyPaid: boolean
    }
  | { ok: false; status: number; message: string; detail?: unknown }

/**
 * LINE Pay confirm 解析：
 * - 新：orderNo=C{cartId} → 先請款再 complete cart（未付款返回不會有訂單）
 * - 舊：orderNo=Medusa order 後綴 → 相容既有未付款單
 * 藍新 ATM／匯款不走此路徑。
 */
export async function resolveOrderAfterLinePayConfirm(opts: {
  scope: MedusaContainer
  orderNo: string
  transactionId: string
  channelId: string
  channelSecret: string
  publishableKey: string
  backendUrl: string
}): Promise<ResolveLinePayResult> {
  const {
    scope,
    orderNo,
    transactionId,
    channelId,
    channelSecret,
    publishableKey,
    backendUrl,
  } = opts

  const query = scope.resolve("query") as {
    graph: (args: Record<string, unknown>) => Promise<{ data: any[] }>
  }

  const cartId = linePayOrderNoToCartId(orderNo)

  if (cartId) {
    if (!publishableKey) {
      return {
        ok: false,
        status: 500,
        message: "伺服器缺少 publishable API key，無法完成 LINE Pay 結帳",
      }
    }

    const { data: carts } = await query.graph({
      entity: "cart",
      fields: [
        "id",
        "email",
        "completed_at",
        "total",
        "subtotal",
        "item_total",
        "metadata",
        "items.quantity",
        "items.unit_price",
        "items.subtotal",
        "items.total",
      ],
      filters: { id: [cartId] },
    })
    const cart = carts?.[0]
    if (!cart?.id) {
      return {
        ok: false,
        status: 404,
        message: "找不到對應購物車（可能已結帳或連結失效）",
      }
    }

    const meta = (cart.metadata || {}) as Record<string, unknown>
    const reserved = resolveTwdAmount(meta.linepay_amount)
    const expected =
      reserved ||
      resolveTwdAmount(
        cart.total,
        cart.item_total,
        cart.subtotal,
        sumLineItemsAmount(cart.items)
      )

    if (meta.linepay_order_no && String(meta.linepay_order_no) !== orderNo) {
      return {
        ok: false,
        status: 409,
        message: "付款編號與購物車不符，已拒絕請款",
      }
    }

    if (reserved > 0) {
      const amountError = verifyPaymentAmount({
        expected,
        reserved,
      })
      if (amountError) {
        return {
          ok: false,
          status: 409,
          message: `金額核對失敗，已拒絕請款：${amountError}`,
        }
      }
    }

    const amount = Math.round(Number(reserved > 0 ? reserved : expected))
    if (!Number.isFinite(amount) || amount < 1 || !Number.isInteger(amount)) {
      return {
        ok: false,
        status: 409,
        message: `金額異常，已拒絕請款（amount=${amount}）`,
      }
    }

    // 重試：cart 已 complete
    if (cart.completed_at) {
      const { data: linked } = await query.graph({
        entity: "cart",
        fields: ["id", "order.id"],
        filters: { id: [cartId] },
      })
      const oid = linked?.[0]?.order?.id
      if (oid) {
        const { data: orders } = await query.graph({
          entity: "order",
          fields: [...ORDER_FIELDS],
          filters: { id: [oid] },
        })
        const order = orders?.[0]
        if (order) {
          return {
            ok: true,
            order,
            amount: Math.round(
              Number(
                resolveTwdAmount(order.metadata?.linepay_amount) ||
                  amount ||
                  resolveOrderTotalDiscountSafe(order)
              )
            ),
            confirmedTxId: String(
              order.metadata?.linepay_transaction_id || transactionId
            ).replace(/^lp:/, ""),
            alreadyPaid: !!order.metadata?.linepay_pay_time,
          }
        }
      }
    }

    const confirmed = await confirmWithLinePay({
      channelId,
      channelSecret,
      transactionId,
      amount,
      orderNo,
      logCtx: { cartId },
    })
    if (!confirmed.ok) return confirmed

    const headers = {
      "Content-Type": "application/json",
      "x-publishable-api-key": publishableKey,
    }
    const { order: created } = await completeMedusaOrderForLinePay(
      scope,
      storeFetch,
      backendUrl,
      headers,
      cartId
    )
    if (!created?.id) {
      return {
        ok: false,
        status: 500,
        message: "付款已成功但建立訂單失敗，請聯絡客服並提供交易編號",
      }
    }

    const { data: orders } = await query.graph({
      entity: "order",
      fields: [...ORDER_FIELDS],
      filters: { id: [created.id] },
    })
    const order = {
      ...(orders?.[0] || created),
      metadata: {
        ...((orders?.[0] || created).metadata || {}),
        ...meta,
        linepay_order_no: orderNo,
        linepay_transaction_id: storeLinePayTxId(confirmed.confirmedTxId),
        linepay_amount: amount,
      },
    }

    return {
      ok: true,
      order,
      amount,
      confirmedTxId: confirmed.confirmedTxId,
      alreadyPaid: false,
    }
  }

  // 舊流程：導轉前已建單
  const orderId = `order_${orderNo}`
  const { data: orders } = await query.graph({
    entity: "order",
    fields: [...ORDER_FIELDS],
    filters: { id: [orderId] },
  })
  const order = orders?.[0]
  if (!order) {
    return { ok: false, status: 404, message: "找不到對應訂單" }
  }

  const expected =
    resolveOrderTotalDiscountSafe(order) ||
    (await loadOrderPayableAmount(scope, order.id, 0))
  const reserved = resolveTwdAmount(order.metadata?.linepay_amount)
  const amountError = verifyPaymentAmount({ expected, reserved })
  if (amountError) {
    return {
      ok: false,
      status: 409,
      message: `金額核對失敗，已拒絕請款：${amountError}`,
    }
  }

  const amount = Math.round(Number(reserved > 0 ? reserved : expected))
  if (!Number.isFinite(amount) || amount < 1 || !Number.isInteger(amount)) {
    return {
      ok: false,
      status: 409,
      message: `金額異常，已拒絕請款（amount=${amount}）`,
    }
  }

  if (order.metadata?.linepay_pay_time) {
    return {
      ok: true,
      order,
      amount,
      confirmedTxId: String(
        order.metadata?.linepay_transaction_id || transactionId
      ).replace(/^lp:/, ""),
      alreadyPaid: true,
    }
  }

  const confirmed = await confirmWithLinePay({
    channelId,
    channelSecret,
    transactionId,
    amount,
    orderNo,
    logCtx: { orderId: order.id },
  })
  if (!confirmed.ok) return confirmed

  return {
    ok: true,
    order: {
      ...order,
      metadata: {
        ...(order.metadata || {}),
        linepay_transaction_id: storeLinePayTxId(confirmed.confirmedTxId),
        linepay_amount: amount,
      },
    },
    amount,
    confirmedTxId: confirmed.confirmedTxId,
    alreadyPaid: false,
  }
}
