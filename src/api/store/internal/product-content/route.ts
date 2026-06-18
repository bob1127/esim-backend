import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Modules } from "@medusajs/framework/utils";
import { updateProductsWorkflow } from "@medusajs/core-flows";

const METADATA_KEY = "detailed_content_by_carrier";

function parseContentMap(raw: unknown): Record<string, string> {
  if (!raw) return {};
  let data: unknown = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    const html = String(v ?? "").trim();
    if (html) out[k] = html;
  }
  return out;
}

/**
 * 內部 API：僅允許帶 X-Product-Admin-Secret 的 Next.js 後台代理呼叫
 * POST { productId, carrier, html, updatedBy? }
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const secret = req.headers["x-product-admin-secret"];
  const expected = process.env.PRODUCT_CONTENT_ADMIN_SECRET;

  if (!expected || expected.length < 16) {
    return res.status(503).json({
      error: "PRODUCT_CONTENT_ADMIN_SECRET 未設定",
    });
  }

  if (!secret || secret !== expected) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const body = (req.body || {}) as {
    productId?: string;
    carrier?: string;
    html?: string;
    updatedBy?: string;
  };

  const productId = String(body.productId || "").trim();
  const carrier = String(body.carrier || "").trim();
  const html = String(body.html ?? "");

  if (!productId || !carrier) {
    return res.status(400).json({ error: "缺少 productId 或 carrier" });
  }

  if (carrier.length > 120) {
    return res.status(400).json({ error: "carrier 名稱過長" });
  }

  if (html.length > 200_000) {
    return res.status(400).json({ error: "內容過長" });
  }

  try {
    const productModule = req.scope.resolve(Modules.PRODUCT) as {
      retrieveProduct: (
        id: string,
      ) => Promise<{ id: string; metadata?: Record<string, unknown> }>;
    };

    const product = await productModule.retrieveProduct(productId);
    if (!product?.id) {
      return res.status(404).json({ error: "找不到商品" });
    }

    const existing = parseContentMap(product.metadata?.[METADATA_KEY]);
    if (html.trim()) {
      existing[carrier] = html;
    } else {
      delete existing[carrier];
    }

    const metadata = {
      ...(product.metadata || {}),
      [METADATA_KEY]: JSON.stringify(existing),
      detailed_content_updated_at: new Date().toISOString(),
      ...(body.updatedBy
        ? { detailed_content_updated_by: String(body.updatedBy).slice(0, 200) }
        : {}),
    };

    await updateProductsWorkflow(req.scope).run({
      input: {
        products: [{ id: productId, metadata }],
      },
    });

    return res.status(200).json({
      success: true,
      productId,
      carrier,
      detailed_content_by_carrier: existing,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[internal/product-content]", message);
    return res.status(500).json({ error: "更新失敗", detail: message });
  }
}
