import { useEffect, useState } from "react"
import { defineWidgetConfig } from "@medusajs/admin-sdk"
import type { DetailWidgetProps, AdminProduct } from "@medusajs/framework/types"
import { Badge, Container, Heading, Text } from "@medusajs/ui"

/**
 * 防呆：商品變體未填 cost_price／b2b_price 時顯示提醒。
 */

type CostCheckResponse = {
  total: number
  ok_count: number
  missing_count: number
  missing: Array<{ id: string; title: string; sku: string }>
  error?: string
}

function labelOf(m: { title: string; sku: string; id: string }) {
  if (m.title && m.sku) return `${m.title}（${m.sku}）`
  if (m.title) return m.title
  if (m.sku) return m.sku
  return m.id
}

const ProductCostPriceGuardWidget = ({
  data,
}: DetailWidgetProps<AdminProduct>) => {
  const productId = data?.id
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [check, setCheck] = useState<CostCheckResponse | null>(null)

  useEffect(() => {
    if (!productId) return
    let cancelled = false
    ;(async () => {
      setLoading(true)
      setError("")
      try {
        const res = await fetch(
          `/admin/products/${encodeURIComponent(productId)}/cost-check`,
          { credentials: "include" },
        )
        const json = (await res.json()) as CostCheckResponse
        if (!res.ok) throw new Error(json.error || "檢查失敗")
        if (!cancelled) setCheck(json)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "檢查失敗")
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [productId])

  const hasMissing = (check?.missing_count || 0) > 0
  const total = check?.total ?? 0

  return (
    <Container className="divide-y p-0 mt-4">
      <div className="px-6 py-4 flex items-center justify-between gap-3">
        <Heading level="h2">成本防呆（cost_price）</Heading>
        {loading ? (
          <Badge size="2xsmall" color="grey">
            檢查中
          </Badge>
        ) : error ? (
          <Badge size="2xsmall" color="red">
            檢查失敗
          </Badge>
        ) : total === 0 ? (
          <Badge size="2xsmall" color="grey">
            無變體
          </Badge>
        ) : hasMissing ? (
          <Badge size="2xsmall" color="orange">
            {check!.missing_count}/{total} 缺成本
          </Badge>
        ) : (
          <Badge size="2xsmall" color="green">
            全部已設定
          </Badge>
        )}
      </div>

      <div className="px-6 py-4 flex flex-col gap-3">
        {loading ? (
          <Text size="small" className="text-ui-fg-subtle">
            正在檢查變體成本…
          </Text>
        ) : error ? (
          <Text size="small" className="text-ui-fg-error">
            {error}
          </Text>
        ) : total === 0 ? (
          <Text size="small" className="text-ui-fg-subtle">
            此商品尚無變體。新增變體後請務必在 Metadata 填
            <code className="mx-1">cost_price</code>
            （供應商成本 TWD），否則主站訂單利潤會顯示偏高。
          </Text>
        ) : hasMissing ? (
          <div
            className="rounded-md px-3 py-3"
            style={{
              background: "#FFF7ED",
              border: "1px solid #FDBA74",
            }}
          >
            <Text size="small" weight="plus" className="text-ui-fg-base">
              提醒：有 {check!.missing_count} 個變體尚未設定成本
            </Text>
            <Text size="xsmall" className="text-ui-fg-subtle mt-1 block">
              未填
              <code className="mx-1">cost_price</code>
              （或
              <code className="mx-1">b2b_price</code>
              ）時，主站訂單「毛利」會把成本當 0，數字會偏高。請到各變體
              Metadata 補上供應商進貨成本（TWD 整數）。
            </Text>
            <ul className="mt-2 pl-4 list-disc flex flex-col gap-1">
              {check!.missing.slice(0, 30).map((m) => (
                <li key={m.id}>
                  <Text size="xsmall" className="text-ui-fg-base">
                    {labelOf(m)}
                  </Text>
                </li>
              ))}
              {check!.missing.length > 30 ? (
                <li>
                  <Text size="xsmall" className="text-ui-fg-muted">
                    …尚有 {check!.missing.length - 30} 個
                  </Text>
                </li>
              ) : null}
            </ul>
          </div>
        ) : (
          <div
            className="rounded-md px-3 py-3"
            style={{
              background: "#F0FDF4",
              border: "1px solid #86EFAC",
            }}
          >
            <Text size="small" weight="plus">
              已完成：{check!.ok_count}/{total} 變體都有成本
            </Text>
            <Text size="xsmall" className="text-ui-fg-subtle mt-1 block">
              新增或複製變體後請再檢查一次，避免漏填。
            </Text>
          </div>
        )}

        <Text size="xsmall" className="text-ui-fg-muted">
          設定方式：Variants → 開啟變體 → Metadata → key=
          <code>cost_price</code>，value=成本金額（例如 85）。
        </Text>
      </div>
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "product.details.side.after",
})

export default ProductCostPriceGuardWidget
