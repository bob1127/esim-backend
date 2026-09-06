import type { MedusaContainer } from "@medusajs/framework/types"
import {
  resolveTwdAmount,
  sumLineItemsAmount,
  loadOrderPayableAmount,
  ORDER_TOTALS_FIELDS,
} from "./orderAmount"

type StoreFetch = (
  backendUrl: string,
  path: string,
  headers: Record<string, string>,
  init?: RequestInit
) => Promise<{ response: Response; data: any }>

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

export async function recoverOrderAfterComplete(
  scope: MedusaContainer,
  storeFetch: StoreFetch,
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
    "metadata",
    // 含 items.*，否則 total／items.total 會全變 0（見 ORDER_TOTALS_FIELDS）
    ...ORDER_TOTALS_FIELDS,
    "payment_collections.amount",
  ]

  try {
    const query = scope.resolve("query") as {
      graph: (args: Record<string, unknown>) => Promise<{ data: any[] }>
    }
    const { data: carts } = await query.graph({
      entity: "cart",
      fields: [
        "id",
        "order.id",
        "order.email",
        "order.metadata",
        // 含 order.items.*，否則 order.total 會是 0（見 ORDER_TOTALS_FIELDS）
        ...ORDER_TOTALS_FIELDS.map((f) => `order.${f}`),
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
      const query = scope.resolve("query") as {
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

/**
 * 將購物車 complete 成訂單（LINE Pay 請款成功後才呼叫）
 */
export async function completeMedusaOrderForLinePay(
  scope: MedusaContainer,
  storeFetch: StoreFetch,
  backendUrl: string,
  headers: Record<string, string>,
  cartId: string
): Promise<{ order: any; cartAmount: number }> {
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
    const recovered = await recoverOrderAfterComplete(
      scope,
      storeFetch,
      backendUrl,
      headers,
      cartId
    )
    if (recovered) {
      const recoveredAmount = await loadOrderPayableAmount(
        scope,
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
    const recovered = await recoverOrderAfterComplete(
      scope,
      storeFetch,
      backendUrl,
      headers,
      cartId
    )
    if (recovered) {
      const recoveredAmount = await loadOrderPayableAmount(
        scope,
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
