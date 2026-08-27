/**
 * Medusa 訂單利潤計算（Admin 訂單詳情用）
 * - 夥伴店：信任 order.metadata.partner_*（結帳時已簽章寫入）
 * - 主站：營收 − Σ(數量 × variant.metadata.cost_price)
 */
import { resolveTwdAmount, sumLineItemsAmount } from "./orderAmount"

export type OrderProfitLine = {
  title: string
  quantity: number
  unit_price: number
  unit_cost: number
  line_revenue: number
  line_cost: number
  line_profit: number
  missing_cost: boolean
}

export type OrderProfitResult = {
  order_id: string
  currency: "TWD"
  channel: "partner" | "main" | "unknown"
  revenue: number
  cost: number
  profit: number
  /** 夥伴店：夥伴分潤 */
  partner_profit?: number
  /** 夥伴店：平台毛利 ≈ revenue − b2b − partner_profit */
  platform_profit?: number
  partner_b2b_cost?: number
  partner_store_id?: string
  partner_id?: string
  missing_cost_lines: number
  lines: OrderProfitLine[]
  note?: string
}

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function metaFlag(meta: Record<string, unknown>, key: string): boolean {
  const v = meta[key]
  return v === true || v === "true" || v === 1 || v === "1"
}

export function isPartnerOrderMeta(meta: Record<string, unknown>): boolean {
  if (metaFlag(meta, "is_partner_order")) return true
  const storeId = num(meta.partner_store_id)
  if (storeId > 0) return true
  const partnerId = num(meta.partner_id)
  return partnerId > 0
}

export function resolveUnitCostFromItem(item: any): number {
  const vMeta = item?.variant?.metadata || {}
  const iMeta = item?.metadata || {}
  const fromMeta = num(
    vMeta.cost_price ??
      vMeta.b2b_price ??
      vMeta.cost ??
      iMeta.cost_price ??
      iMeta.b2b_price ??
      iMeta.cost,
  )
  return fromMeta > 0 ? Math.round(fromMeta) : 0
}

function orderRevenue(order: any): number {
  return (
    resolveTwdAmount(
      order?.total,
      order?.summary?.total,
      order?.summary?.current_order_total,
      order?.item_total,
      order?.subtotal,
      order?.metadata?.newebpay_amount,
      order?.metadata?.partner_total,
      sumLineItemsAmount(order?.items),
    ) || 0
  )
}

export function computeOrderProfit(order: any): OrderProfitResult {
  const meta = (order?.metadata || {}) as Record<string, unknown>
  const items = Array.isArray(order?.items) ? order.items : []
  const revenue = orderRevenue(order)

  if (isPartnerOrderMeta(meta)) {
    const b2b = Math.round(num(meta.partner_b2b_cost))
    const partnerProfit = Math.round(num(meta.partner_profit))
    const partnerTotal = Math.round(num(meta.partner_total)) || revenue
    const platformProfit = Math.max(0, partnerTotal - b2b - partnerProfit)

    return {
      order_id: String(order?.id || ""),
      currency: "TWD",
      channel: "partner",
      revenue: partnerTotal,
      cost: b2b,
      profit: platformProfit,
      partner_profit: partnerProfit,
      platform_profit: platformProfit,
      partner_b2b_cost: b2b,
      partner_store_id: meta.partner_store_id
        ? String(meta.partner_store_id)
        : undefined,
      partner_id: meta.partner_id ? String(meta.partner_id) : undefined,
      missing_cost_lines: 0,
      lines: [],
      note: "夥伴店訂單：利潤取自結帳寫入的 metadata（含金流手續費計算）",
    }
  }

  const lines: OrderProfitLine[] = items.map((it: any) => {
    const qty = Math.max(1, Math.round(num(it?.quantity) || 1))
    const unitPrice = resolveTwdAmount(
      it?.unit_price,
      it?.raw_unit_price,
      it?.subtotal != null && qty ? Number(it.subtotal) / qty : 0,
    )
    const unitCost = resolveUnitCostFromItem(it)
    const lineRevenue =
      resolveTwdAmount(it?.total, it?.subtotal) || unitPrice * qty
    const lineCost = unitCost * qty
    return {
      title: String(
        it?.product_title || it?.title || it?.variant_title || "商品",
      ),
      quantity: qty,
      unit_price: unitPrice,
      unit_cost: unitCost,
      line_revenue: lineRevenue,
      line_cost: lineCost,
      line_profit: lineRevenue - lineCost,
      missing_cost: unitCost <= 0,
    }
  })

  const cost = lines.reduce((s, l) => s + l.line_cost, 0)
  const missing = lines.filter((l) => l.missing_cost).length

  return {
    order_id: String(order?.id || ""),
    currency: "TWD",
    channel: "main",
    revenue,
    cost,
    profit: revenue - cost,
    missing_cost_lines: missing,
    lines,
    note:
      missing > 0
        ? `有 ${missing} 項商品缺少 cost_price，利潤可能偏高`
        : "主站訂單：成本來自變體 metadata.cost_price",
  }
}
