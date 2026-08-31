import { useEffect, useState } from "react"
import { defineWidgetConfig } from "@medusajs/admin-sdk"
import type { DetailWidgetProps, AdminOrder } from "@medusajs/framework/types"
import { Container, Heading, Text, Badge } from "@medusajs/ui"

type ProfitPayload = {
  order_id: string
  channel: "partner" | "referral" | "main" | "unknown"
  revenue: number
  cost: number
  profit: number
  partner_profit?: number
  platform_profit?: number
  partner_b2b_cost?: number
  partner_store_id?: string
  partner_id?: string
  referral_code?: string
  missing_cost_lines: number
  lines: Array<{
    title: string
    quantity: number
    unit_cost: number
    line_cost: number
    line_profit: number
    missing_cost: boolean
  }>
  note?: string
  error?: string
}

function twd(n: number | undefined) {
  if (n == null || !Number.isFinite(n)) return "—"
  return `NT$ ${Math.round(n).toLocaleString("zh-TW")}`
}

function Row({
  label,
  value,
  emphasize,
}: {
  label: string
  value: string
  emphasize?: boolean
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 12,
        fontSize: 13,
        lineHeight: 1.5,
      }}
    >
      <Text size="small" className="text-ui-fg-subtle">
        {label}
      </Text>
      <Text
        size="small"
        weight={emphasize ? "plus" : "regular"}
        className={emphasize ? "text-ui-fg-base" : undefined}
      >
        {value}
      </Text>
    </div>
  )
}

const OrderProfitWidget = ({ data }: DetailWidgetProps<AdminOrder>) => {
  const orderId = data?.id
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [profit, setProfit] = useState<ProfitPayload | null>(null)

  useEffect(() => {
    if (!orderId) return
    let cancelled = false
    ;(async () => {
      setLoading(true)
      setError("")
      try {
        const res = await fetch(
          `/admin/orders/${encodeURIComponent(orderId)}/profit`,
          { credentials: "include" },
        )
        const json = (await res.json()) as ProfitPayload
        if (!res.ok) throw new Error(json.error || "讀取失敗")
        if (!cancelled) setProfit(json)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "讀取失敗")
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [orderId])

  // 主站與優惠連結都是用變體 cost_price 算成本，兩者都要做缺成本防呆
  const costFromVariants =
    profit?.channel === "main" || profit?.channel === "referral"
  const missingLines = costFromVariants
    ? (profit?.lines || []).filter((l) => l.missing_cost)
    : []
  const hasMissingCost =
    costFromVariants && (profit?.missing_cost_lines || 0) > 0
  const showPartnerShare =
    profit?.channel === "partner" || profit?.channel === "referral"

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <Heading level="h2">訂單利潤</Heading>
        {hasMissingCost ? (
          <Badge color="orange" size="2xsmall">
            缺成本
          </Badge>
        ) : profit?.channel === "partner" ? (
          <Badge color="blue" size="2xsmall">
            夥伴店
          </Badge>
        ) : profit?.channel === "referral" ? (
          <Badge color="purple" size="2xsmall">
            優惠連結
          </Badge>
        ) : profit?.channel === "main" ? (
          <Badge color="green" size="2xsmall">
            主站
          </Badge>
        ) : null}
      </div>

      <div className="px-6 py-4 flex flex-col gap-2">
        {loading ? (
          <Text size="small" className="text-ui-fg-subtle">
            計算中…
          </Text>
        ) : error ? (
          <Text size="small" className="text-ui-fg-error">
            {error}
          </Text>
        ) : profit ? (
          <>
            {hasMissingCost ? (
              <div
                className="rounded-md px-3 py-3 mb-1"
                style={{
                  background: "#FFF7ED",
                  border: "1px solid #FDBA74",
                }}
              >
                <Text size="small" weight="plus" className="text-ui-fg-base">
                  防呆提醒：此單有 {profit.missing_cost_lines}{" "}
                  項商品未設定 cost_price
                </Text>
                <Text
                  size="xsmall"
                  className="text-ui-fg-subtle mt-1 block"
                >
                  成本被當成 NT$0，下方「毛利」會偏高，請到對應商品變體
                  Metadata 補上成本後再核對。
                </Text>
                {missingLines.length > 0 ? (
                  <ul className="mt-2 pl-4 list-disc">
                    {missingLines.map((line, i) => (
                      <li key={i}>
                        <Text size="xsmall">
                          {line.title} × {line.quantity}
                        </Text>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}

            <Row label="營收（實收）" value={twd(profit.revenue)} />
            <Row
              label={
                profit.channel === "partner" ? "B2B 成本" : "商品成本"
              }
              value={twd(profit.cost)}
            />
            {showPartnerShare ? (
              <>
                <Row
                  label="夥伴分潤"
                  value={twd(profit.partner_profit)}
                />
                <Row
                  label={
                    hasMissingCost ? "平台利潤（可能偏高）" : "平台利潤"
                  }
                  value={twd(profit.platform_profit ?? profit.profit)}
                  emphasize
                />
              </>
            ) : (
              <Row
                label={hasMissingCost ? "毛利（可能偏高）" : "毛利"}
                value={twd(profit.profit)}
                emphasize
              />
            )}

            {profit.partner_store_id ? (
              <Row label="store_id" value={String(profit.partner_store_id)} />
            ) : null}

            {profit.referral_code ? (
              <Row label="推薦代碼" value={profit.referral_code} />
            ) : null}

            {profit.note && !hasMissingCost ? (
              <Text size="xsmall" className="text-ui-fg-muted mt-1">
                {profit.note}
              </Text>
            ) : null}

            {costFromVariants && profit.lines?.length > 0 ? (
              <div className="mt-3 flex flex-col gap-2 border-t border-ui-border-base pt-3">
                <Text size="small" weight="plus">
                  明細成本
                </Text>
                {profit.lines.map((line, i) => (
                  <div key={i} className="flex flex-col gap-0.5">
                    <Text
                      size="xsmall"
                      className={
                        line.missing_cost
                          ? "text-ui-fg-error"
                          : "text-ui-fg-base"
                      }
                    >
                      {line.title} × {line.quantity}
                      {line.missing_cost ? " — 缺 cost_price" : ""}
                    </Text>
                    <Text size="xsmall" className="text-ui-fg-subtle">
                      成本 {twd(line.line_cost)} · 行利潤{" "}
                      {twd(line.line_profit)}
                    </Text>
                  </div>
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <Text size="small" className="text-ui-fg-subtle">
            尚無資料
          </Text>
        )}
      </div>
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "order.details.side.after",
})

export default OrderProfitWidget
