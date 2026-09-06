import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { computeOrderProfit } from "../../../../../lib/orderProfit"

/**
 * GET /admin/orders/:id/profit
 * 訂單利潤（夥伴 metadata 或主站 cost_price）。需 Medusa Admin 登入。
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const orderId = String(req.params.id || "").trim()
  if (!orderId) {
    return res.status(400).json({ error: "缺少訂單 id" })
  }

  try {
    const query = req.scope.resolve("query") as {
      graph: (args: Record<string, unknown>) => Promise<{ data: any[] }>
    }

    const { data } = await query.graph({
      entity: "order",
      fields: [
        "id",
        "currency_code",
        "metadata",
        // 含 items.*，否則 total／items.total 會是 0（見 ORDER_TOTALS_FIELDS）
        "total",
        "subtotal",
        "item_total",
        "discount_total",
        "summary.*",
        "items.*",
        "items.id",
        "items.title",
        "items.product_title",
        "items.variant_title",
        "items.quantity",
        "items.unit_price",
        "items.subtotal",
        "items.total",
        "items.metadata",
        "items.variant_id",
        "items.variant.id",
        "items.variant.sku",
        "items.variant.metadata",
      ],
      filters: { id: [orderId] },
    })

    const order = data?.[0]
    if (!order?.id) {
      return res.status(404).json({ error: "找不到訂單" })
    }

    const profit = computeOrderProfit(order)
    return res.status(200).json(profit)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[admin/orders/profit]", message)
    return res.status(500).json({ error: "計算利潤失敗", detail: message })
  }
}
