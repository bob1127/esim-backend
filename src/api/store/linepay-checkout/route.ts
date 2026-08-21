import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import crypto from "crypto"

const PROVIDER_ID = "pp_newebpay_newebpay"
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

  try {
    const query = req.scope.resolve("query") as {
      graph: (args: Record<string, unknown>) => Promise<{ data: any[] }>
    }
    const { data: carts } = await query.graph({
      entity: "cart",
      fields: ["id", "order.id", "order.email", "order.total", "order.metadata"],
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
        fields: ["id", "email", "total", "metadata", "created_at"],
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
) {
  const existingCart = await storeFetch(backendUrl, `/store/carts/${cartId}`, headers)
  if (existingCart.data?.cart?.completed_at) {
    const recovered = await recoverOrderAfterComplete(req, backendUrl, headers, cartId)
    if (recovered) return recovered
  }

  const payColRes = await storeFetch(backendUrl, "/store/payment-collections", headers, {
    method: "POST",
    body: JSON.stringify({ cart_id: cartId }),
  })
  const payColId = payColRes.data?.payment_collection?.id
  if (!payColId) throw new Error("無法建立付款流程（payment collection）")

  // 本機/測試環境可能尚未安裝對應的 payment provider（例如 pp_newebpay_newebpay），
  // 這時 fallback 到系統預設 provider，避免 cart 無法 complete。
  const fallbackProviderId = process.env.MEDUSA_PAYMENT_PROVIDER_ID || "pp_system_default"
  const providerIdsToTry = Array.from(new Set([PROVIDER_ID, fallbackProviderId])).filter(Boolean)

  let lastSessionRes: any = null
  for (const providerId of providerIdsToTry) {
    lastSessionRes = await storeFetch(
      backendUrl,
      `/store/payment-collections/${payColId}/payment-sessions`,
      headers,
      {
        method: "POST",
        body: JSON.stringify({ provider_id: providerId }),
      }
    )

    if (lastSessionRes.response?.ok) break
  }

  // 即使 payment-sessions 失敗，下面 complete 才會回更明確的錯誤訊息
  // （這裡不直接 throw，避免遮蔽 Medusa 的原始錯誤）

  const completeRes = await storeFetch(backendUrl, `/store/carts/${cartId}/complete`, headers, {
    method: "POST",
    headers: { "Idempotency-Key": `linepay_complete_${cartId}` },
  })

  if (completeRes.response.ok && completeRes.data?.type === "order") return completeRes.data.order

  if (completeRes.response.status === 409 || completeRes.data?.type === "cart") {
    const recovered = await recoverOrderAfterComplete(req, backendUrl, headers, cartId)
    if (recovered) return recovered
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
  const { cart_id } = req.body as { cart_id?: string }
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
    const order = await completeMedusaOrder(req, backendUrl, headers, cart_id)
    if (!order?.id) {
      return res.status(500).json({ message: "訂單建立失敗，請稍後再試" })
    }

    const merchantOrderNo = toMerchantOrderNo(order.id)
    const amount = Math.max(Math.round(Number(order.total ?? 0)), 1)
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

    const lineData = await lineRes.json().catch(() => ({}))
    if (!lineRes.ok || lineData?.returnCode !== "0000") {
      return res.status(400).json({
        message: "LINE Pay 建立付款失敗",
        detail: lineData,
      })
    }

    try {
      const orderModule = req.scope.resolve("order") as {
        updateOrders: (data: Array<{ id: string; metadata: Record<string, unknown> }>) => Promise<unknown>
      }
      await orderModule.updateOrders([
        {
          id: order.id,
          metadata: {
            ...(order.metadata || {}),
            linepay_order_no: merchantOrderNo,
            linepay_transaction_id: String(lineData?.info?.transactionId || ""),
          },
        },
      ])
    } catch {
      // metadata 寫失敗不阻斷付款
    }

    return res.status(200).json({
      success: true,
      orderId: order.id,
      orderNo: merchantOrderNo,
      amount,
      transactionId: lineData?.info?.transactionId,
      paymentUrl: lineData?.info?.paymentUrl?.web,
      paymentAccessToken: lineData?.info?.paymentAccessToken,
    })
  } catch (error: any) {
    return res.status(500).json({ message: error?.message || "LINE Pay 結帳失敗" })
  }
}
