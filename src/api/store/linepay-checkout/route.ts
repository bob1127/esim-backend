import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import crypto from "crypto"
import {
  resolveTwdAmount,
  sumLineItemsAmount,
  loadOrderPayableAmount,
} from "../../../lib/orderAmount"
import {
  extractJsonStringField,
  storeLinePayTxId,
} from "../../../lib/linePayIds"
import { buildMemberIdentityMetadata } from "../../../lib/memberIdentity"

const LINEPAY_BASE = process.env.LINEPAY_API_BASE || "https://api-pay.line.me"

function resolveStoreUrl() {
  return (process.env.STORE_URL || "https://www.jeko-esim.com.tw").replace(/\/$/, "")
}

function storeHeaders(pubKey: string) {
  return {
    "Content-Type": "application/json",
    "x-publishable-api-key": pubKey,
  }
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

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function recoverOrderAfterComplete(
  req: MedusaRequest,
  backendUrl: string,
  headers: Record<string, string>,
  cartId: string
) {
  let cartEmail: string | undefined
  for (let i = 0; i < 8; i++) {
    const cartRes = await storeFetch(backendUrl, `/store/carts/${cartId}`, headers)
    const cart = cartRes.data?.cart
    cartEmail = cart?.email || cartEmail
    if (cart?.completed_at) break
    await sleep(300 + i * 150)
  }

  const orderFields = [
    "id",
    "email",
    "total",
    "subtotal",
    "item_total",
    "metadata",
    "summary.*",
    "items.quantity",
    "items.unit_price",
    "items.subtotal",
    "items.total",
    "items.raw_unit_price",
    "payment_collections.amount",
  ]

  try {
    const query = req.scope.resolve("query") as {
      graph: (args: Record<string, unknown>) => Promise<{ data: any[] }>
    }
    const { data: carts } = await query.graph({
      entity: "cart",
      fields: [
        "id",
        "order.id",
        "order.email",
        "order.total",
        "order.subtotal",
        "order.item_total",
        "order.metadata",
        "order.summary.*",
        "order.items.quantity",
        "order.items.unit_price",
        "order.items.subtotal",
        "order.items.total",
        "order.items.raw_unit_price",
        "order.payment_collections.amount",
      ],
      filters: { id: [cartId] },
    })
    const linked = carts?.[0]?.order
    if (linked?.id) return linked
  } catch {
    // noop
  }

  if (cartEmail) {
    try {
      const query = req.scope.resolve("query") as {
        graph: (args: Record<string, unknown>) => Promise<{ data: any[] }>
      }
      const { data: orders } = await query.graph({
        entity: "order",
        fields: [...orderFields, "created_at"],
        filters: { email: cartEmail },
      })
      const sorted = (orders || []).sort(
        (a, b) =>
          new Date(b.created_at || 0).getTime() -
          new Date(a.created_at || 0).getTime()
      )
      if (sorted[0]?.id) return sorted[0]
    } catch {
      // noop
    }
  }

  return null
}

async function completeMedusaOrder(
  req: MedusaRequest,
  backendUrl: string,
  headers: Record<string, string>,
  cartId: string
): Promise<{ order: any; cartAmount: number }> {
  // 明確要求 totals／items：complete 後 cart 會變空，金額必須在「尚未完成」時抓到
  const existingCart = await storeFetch(
    backendUrl,
    `/store/carts/${cartId}?fields=+total,+subtotal,+item_total,*items,*items.variant,completed_at,email,*payment_collection`,
    headers
  )
  const cart = existingCart.data?.cart
  const cartStillOpen = !cart?.completed_at
  const cartAmount = cartStillOpen
    ? resolveTwdAmount(
        cart?.total,
        cart?.item_total,
        cart?.subtotal,
        sumLineItemsAmount(cart?.items)
      )
    : 0

  if (cart?.completed_at) {
    const recovered = await recoverOrderAfterComplete(req, backendUrl, headers, cartId)
    if (recovered) {
      const recoveredAmount = await loadOrderPayableAmount(
        req.scope,
        recovered.id,
        resolveTwdAmount(
          recovered?.total,
          recovered?.item_total,
          (recovered as any)?.summary?.total,
          sumLineItemsAmount((recovered as any)?.items)
        )
      )
      return { order: recovered, cartAmount: recoveredAmount }
    }
  }

  const providerId =
    process.env.MEDUSA_LINEPAY_PAYMENT_PROVIDER_ID ||
    process.env.MEDUSA_PAYMENT_PROVIDER_ID ||
    "pp_system_default"

  // 重試結帳時重用既有 payment collection，少一次建立
  let payColId =
    cart?.payment_collection?.id ||
    cart?.payment_collection_id ||
    null

  if (!payColId) {
    const payColRes = await storeFetch(backendUrl, "/store/payment-collections", headers, {
      method: "POST",
      body: JSON.stringify({ cart_id: cartId }),
    })
    payColId = payColRes.data?.payment_collection?.id
  }
  if (!payColId) throw new Error("無法建立付款流程（payment collection）")

  await storeFetch(
    backendUrl,
    `/store/payment-collections/${payColId}/payment-sessions`,
    headers,
    {
      method: "POST",
      body: JSON.stringify({ provider_id: providerId }),
    }
  )

  const completeRes = await storeFetch(backendUrl, `/store/carts/${cartId}/complete`, headers, {
    method: "POST",
    headers: { "Idempotency-Key": `linepay_complete_${cartId}` },
  })

  if (completeRes.response.ok && completeRes.data?.type === "order") {
    return { order: completeRes.data.order, cartAmount }
  }

  if (completeRes.response.status === 409 || completeRes.data?.type === "cart") {
    const recovered = await recoverOrderAfterComplete(req, backendUrl, headers, cartId)
    if (recovered) {
      const recoveredAmount = await loadOrderPayableAmount(
        req.scope,
        recovered.id,
        cartAmount ||
          resolveTwdAmount(
            recovered?.total,
            recovered?.item_total,
            sumLineItemsAmount((recovered as any)?.items)
          )
      )
      return { order: recovered, cartAmount: recoveredAmount || cartAmount }
    }
  }

  throw new Error(completeRes.data?.message || "訂單建立失敗")
}

function toMerchantOrderNo(orderId: string) {
  return orderId.replace(/^order_/, "")
}

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

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const { cart_id, orderInfo } = req.body as {
    cart_id?: string
    orderInfo?: Record<string, unknown>
  }
  const pubKey = req.headers["x-publishable-api-key"] as string

  if (!pubKey) return res.status(400).json({ message: "缺少 x-publishable-api-key" })
  if (!cart_id) return res.status(400).json({ message: "缺少 cart_id" })

  const channelId = process.env.LINEPAY_CHANNEL_ID
  const channelSecret = process.env.LINEPAY_CHANNEL_SECRET
  if (!channelId || !channelSecret) {
    return res.status(503).json({ message: "LINE Pay 金鑰未設定" })
  }

  const backendUrl = (process.env.MEDUSA_BACKEND_URL || "http://localhost:9000").replace(/\/$/, "")
  const headers = storeHeaders(pubKey)

  try {
    const { order, cartAmount } = await completeMedusaOrder(
      req,
      backendUrl,
      headers,
      cart_id
    )
    if (!order?.id) {
      return res.status(500).json({ message: "訂單建立失敗，請稍後再試" })
    }

    const merchantOrderNo = toMerchantOrderNo(order.id)
    let amount = await loadOrderPayableAmount(req.scope, order.id, cartAmount)
    // complete 剛結束時 summary／items 偶發尚未算完，短等再讀一次
    if (!amount || amount < 1) {
      await sleep(400)
      amount = await loadOrderPayableAmount(req.scope, order.id, cartAmount)
    }
    if (!amount || amount < 1) {
      console.error(
        `[linepay-checkout] 金額為 0：order=${order.id} cartAmount=${cartAmount}`,
        {
          orderTotal: order?.total,
          itemTotal: order?.item_total,
          items: (order?.items || []).map((it: any) => ({
            qty: it?.quantity,
            unit: it?.unit_price,
            total: it?.total,
          })),
        }
      )
      return res.status(400).json({
        message: `訂單金額異常（${amount || 0}），無法建立 LINE Pay。請重新整理頁面、清空後再加入商品重試。`,
        orderId: order.id,
        cartAmount,
      })
    }
    // TWD：LINE Pay 要求整數金額，否則 confirm 會回 1124（scale）
    amount = Math.round(Number(amount))
    if (!Number.isInteger(amount) || amount < 1) {
      return res.status(400).json({
        message: `訂單金額非整數（${amount}），無法建立 LINE Pay。`,
        orderId: order.id,
      })
    }
    const storeUrl = resolveStoreUrl()

    const requestBody = {
      amount,
      currency: "TWD",
      orderId: merchantOrderNo,
      packages: [
        {
          id: "1",
          amount,
          name: "Jeko eSIM",
          products: [{ name: "eSIM 訂單", quantity: 1, price: amount }],
        },
      ],
      redirectUrls: {
        confirmUrl: `${storeUrl}/linepay-confirm?orderNo=${encodeURIComponent(merchantOrderNo)}`,
        cancelUrl: `${storeUrl}/Cart?linepay=cancel`,
      },
    }

    const apiPath = "/v4/payments/request"
    const rawBody = JSON.stringify(requestBody)
    const nonce = crypto.randomUUID()
    const signature = signLinePay(channelSecret, apiPath, rawBody, nonce)

    const lineRes = await fetch(`${LINEPAY_BASE}${apiPath}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-LINE-ChannelId": channelId,
        "X-LINE-Authorization-Nonce": nonce,
        "X-LINE-Authorization": signature,
      },
      body: rawBody,
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
      return res.status(400).json({
        message: "LINE Pay 建立付款失敗",
        detail: lineData,
      })
    }

    const paymentUrl = lineData?.info?.paymentUrl?.web
    // 19 位 transactionId 必須從原文抽取，避免 JSON Number 精度遺失
    const transactionId =
      extractJsonStringField(lineRaw, "transactionId") ||
      String(lineData?.info?.transactionId || "")

    // 夥伴店訂單：把 cart.metadata 內「已由簽章驗證過」的分潤歸屬複製到 order
    let partnerMeta: Record<string, unknown> = {}
    try {
      const query = req.scope.resolve("query") as {
        graph: (args: Record<string, unknown>) => Promise<{ data: any[] }>
      }
      const { data: carts } = await query.graph({
        entity: "cart",
        fields: ["id", "metadata"],
        filters: { id: [cart_id] },
      })
      const cm = (carts?.[0]?.metadata || {}) as Record<string, unknown>
      if (cm.is_partner_order) {
        partnerMeta = {
          is_partner_order: true,
          partner_store_id: cm.partner_store_id ?? "",
          partner_id: cm.partner_id ?? "",
          partner_total: cm.partner_total ?? amount,
          partner_b2b_cost: cm.partner_b2b_cost ?? 0,
          partner_profit: cm.partner_profit ?? 0,
        }
      }
    } catch {
      // 讀取失敗不阻斷付款
    }

    // 金額與交易編號必須在導轉前寫入（confirm 交叉核對用）
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
            linepay_order_no: merchantOrderNo,
            linepay_transaction_id: storeLinePayTxId(transactionId),
            linepay_amount: amount,
            // 會員身分「蓋章」：讓會員中心可依此對回本人訂單
            ...buildMemberIdentityMetadata(orderInfo, order.email),
            ...partnerMeta,
          },
        },
      ])
    } catch {
      // metadata 寫失敗不阻斷付款（confirm 會以 LINE Pay orderId + DB 金額核對）
    }

    return res.status(200).json({
      success: true,
      orderId: order.id,
      orderNo: merchantOrderNo,
      amount,
      transactionId,
      paymentUrl,
      paymentAccessToken: lineData?.info?.paymentAccessToken,
    })
  } catch (error: any) {
    return res.status(500).json({ message: error?.message || "LINE Pay 結帳失敗" })
  }
}
