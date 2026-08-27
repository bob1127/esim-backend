import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Modules } from "@medusajs/framework/utils"

/**
 * GET /admin/products/:id/cost-check
 * 列出缺少 cost_price／b2b_price 的變體（Admin 防呆用）。
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const productId = String(req.params.id || "").trim()
  if (!productId) {
    return res.status(400).json({ error: "缺少 product id" })
  }

  try {
    const productModule = req.scope.resolve(Modules.PRODUCT) as {
      retrieveProduct: (
        id: string,
        config?: Record<string, unknown>,
      ) => Promise<{
        id: string
        title?: string
        variants?: Array<{
          id: string
          title?: string | null
          sku?: string | null
          metadata?: Record<string, unknown> | null
        }>
      }>
    }

    const product = await productModule.retrieveProduct(productId, {
      relations: ["variants"],
    })
    if (!product?.id) {
      return res.status(404).json({ error: "找不到商品" })
    }

    const variants = product.variants || []
    const missing: Array<{ id: string; title: string; sku: string }> = []
    let ok = 0

    for (const v of variants) {
      const meta = (v.metadata || {}) as Record<string, unknown>
      const raw = meta.cost_price ?? meta.b2b_price ?? meta.cost
      const n = Number(raw)
      if (Number.isFinite(n) && n > 0) {
        ok += 1
      } else {
        missing.push({
          id: v.id,
          title: String(v.title || "").trim(),
          sku: String(v.sku || "").trim(),
        })
      }
    }

    return res.status(200).json({
      product_id: productId,
      product_title: product.title || "",
      total: variants.length,
      ok_count: ok,
      missing_count: missing.length,
      missing,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return res.status(500).json({ error: "檢查失敗", detail: message })
  }
}
