import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import crypto from "crypto"
import { Modules } from "@medusajs/framework/utils"
import {
  resolveTwdAmount,
  sumLineItemsAmount,
} from "../../../lib/orderAmount"
import {
  extractJsonStringField,
  storeLinePayTxId,
} from "../../../lib/linePayIds"
import { buildMemberIdentityMetadata } from "../../../lib/memberIdentity"
import { cartIdToLinePayOrderNo } from "../../../lib/linePayOrderNo"

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

/**
 * LINE Pay request：此時不 complete cart、不建立 Medusa order。
 * （藍新 ATM／匯款仍走 newebpay-checkout 先建單，與此無關。）
 * 客人未付款就返回 → 購物車仍在、後台不會多一筆未付款單。
 */
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

  const backendUrl = (process.env.MEDUSA_BACKEND_URL || "http://localhost:9000").replace(
    /\/$/,
    ""
  )
  const headers = storeHeaders(pubKey)

  try {
    const cartRes = await storeFetch(
      backendUrl,
      `/store/carts/${cart_id}?fields=+total,+subtotal,+item_total,*items,*items.variant,completed_at,email,metadata,*payment_collection`,
      headers
    )
    const cart = cartRes.data?.cart
    if (!cart?.id) {
      return res.status(404).json({ message: "找不到購物車" })
    }
    if (cart.completed_at) {
      return res.status(400).json({
        message: "購物車已結帳完成，請重新加入商品後再結帳。",
        code: "CART_COMPLETED",
      })
    }
    if (!Array.isArray(cart.items) || cart.items.length === 0) {
      return res.status(400).json({
        message: "購物車是空的",
        code: "EMPTY_CART",
      })
    }

    let amount = resolveTwdAmount(
      cart.total,
      cart.item_total,
      cart.subtotal,
      sumLineItemsAmount(cart.items)
    )
    amount = Math.round(Number(amount) || 0)
    if (!Number.isInteger(amount) || amount < 1) {
      return res.status(400).json({
        message: `購物車金額異常（${amount || 0}），無法建立 LINE Pay。`,
        cartAmount: amount,
      })
    }

    const merchantOrderNo = cartIdToLinePayOrderNo(cart_id)
    const storeUrl = resolveStoreUrl()

    const cm = (cart.metadata || {}) as Record<string, unknown>
    let partnerMeta: Record<string, unknown> = {}
    if (cm.is_partner_order) {
      partnerMeta = {
        is_partner_order: true,
        partner_store_id: cm.partner_store_id ?? "",
        partner_id: cm.partner_id ?? "",
        partner_total: cm.partner_total ?? amount,
        partner_b2b_cost: cm.partner_b2b_cost ?? 0,
        partner_profit: cm.partner_profit ?? 0,
      }
    } else if (cm.jeko_referral_code) {
      partnerMeta = {
        jeko_referral_code: String(cm.jeko_referral_code),
      }
    }

    const identityMeta = buildMemberIdentityMetadata(orderInfo, cart.email)

    // 先把核對用欄位寫入 cart.metadata（付款成功後 confirm 再 complete）
    try {
      const cartModule = req.scope.resolve(Modules.CART) as {
        updateCarts: (
          data: Array<{ id: string; metadata?: Record<string, unknown> }>
        ) => Promise<unknown>
      }
      await cartModule.updateCarts([
        {
          id: cart_id,
          metadata: {
            ...cm,
            linepay_order_no: merchantOrderNo,
            linepay_amount: amount,
            linepay_status: "requested",
            linepay_requested_at: new Date().toISOString(),
            ...identityMeta,
            ...partnerMeta,
          },
        },
      ])
    } catch (e: any) {
      console.warn(
        "[linepay-checkout] 寫入 cart metadata 失敗（仍繼續向 LINE 建單）:",
        e?.message || e
      )
    }

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
        cancelUrl: `${storeUrl}/api/linepay/cancel?orderNo=${encodeURIComponent(merchantOrderNo)}`,
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
    const transactionId =
      extractJsonStringField(lineRaw, "transactionId") ||
      String(lineData?.info?.transactionId || "")

    if (!paymentUrl) {
      return res.status(400).json({
        message: "LINE Pay 未回傳付款網址",
        detail: lineData,
      })
    }

    // 寫入 transactionId 不阻塞導轉（confirm 會帶 query 上的 transactionId）
    void (async () => {
      try {
        const cartModule = req.scope.resolve(Modules.CART) as {
          updateCarts: (
            data: Array<{ id: string; metadata?: Record<string, unknown> }>
          ) => Promise<unknown>
        }
        await cartModule.updateCarts([
          {
            id: cart_id,
            metadata: {
              ...cm,
              linepay_order_no: merchantOrderNo,
              linepay_amount: amount,
              linepay_transaction_id: storeLinePayTxId(transactionId),
              linepay_status: "requested",
              linepay_requested_at:
                (cm.linepay_requested_at as string) ||
                new Date().toISOString(),
              ...identityMeta,
              ...partnerMeta,
            },
          },
        ])
      } catch (e: any) {
        console.warn(
          "[linepay-checkout] 背景寫入 transactionId 失敗:",
          e?.message || e
        )
      }
    })()

    return res.status(200).json({
      success: true,
      // 付款成功前尚無 Medusa order
      orderId: null,
      cartId: cart_id,
      orderNo: merchantOrderNo,
      amount,
      transactionId,
      paymentUrl,
      paymentAccessToken: lineData?.info?.paymentAccessToken,
      deferredOrder: true,
    })
  } catch (error: any) {
    return res.status(500).json({ message: error?.message || "LINE Pay 結帳失敗" })
  }
}
