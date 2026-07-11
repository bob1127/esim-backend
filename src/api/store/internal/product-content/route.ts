import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Modules } from "@medusajs/framework/utils";
import { updateProductsWorkflow } from "@medusajs/core-flows";

const CONTENT_METADATA_KEYS = {
  detailed: "detailed_content_by_carrier",
  usage: "usage_content_by_carrier",
  faq: "faq_content_by_carrier",
  overview: "overview_notices_by_carrier",
} as const;

type HtmlContentType = "detailed" | "usage" | "faq";
type ContentType = HtmlContentType | "overview";

function resolveContentType(raw: unknown): ContentType {
  if (raw === "usage") return "usage";
  if (raw === "faq") return "faq";
  if (raw === "overview") return "overview";
  return "detailed";
}

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

type OverviewNotice = {
  fup_notice?: string;
  activation_notice?: string;
};

function parseOverviewMap(raw: unknown): Record<string, OverviewNotice> {
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

  const out: Record<string, OverviewNotice> = {};
  for (const [carrier, notice] of Object.entries(
    data as Record<string, unknown>,
  )) {
    if (!notice || typeof notice !== "object" || Array.isArray(notice)) continue;
    const obj = notice as Record<string, unknown>;
    const fup_notice = String(obj.fup_notice ?? "").trim();
    const activation_notice = String(obj.activation_notice ?? "").trim();
    if (fup_notice || activation_notice) {
      out[carrier] = {
        ...(fup_notice ? { fup_notice } : {}),
        ...(activation_notice ? { activation_notice } : {}),
      };
    }
  }
  return out;
}

/**
 * 內部 API：僅允許帶 X-Product-Admin-Secret 的 Next.js 後台代理呼叫
 * POST { productId, carrier, html?, updatedBy?, contentType?, fup_notice?, activation_notice? }
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
    contentType?: string;
    fup_notice?: string;
    activation_notice?: string;
  };

  const productId = String(body.productId || "").trim();
  const carrier = String(body.carrier || "").trim();
  const html = String(body.html ?? "");
  const contentType = resolveContentType(body.contentType);
  const metadataKey = CONTENT_METADATA_KEYS[contentType];

  if (!productId || !carrier) {
    return res.status(400).json({ error: "缺少 productId 或 carrier" });
  }

  if (carrier.length > 120) {
    return res.status(400).json({ error: "carrier 名稱過長" });
  }

  if (contentType !== "overview" && html.length > 200_000) {
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

    let responsePayload: Record<string, unknown> = {
      success: true,
      productId,
      carrier,
      contentType,
    };

    const metadata: Record<string, unknown> = {
      ...(product.metadata || {}),
      [`${contentType}_content_updated_at`]: new Date().toISOString(),
      ...(body.updatedBy
        ? {
            [`${contentType}_content_updated_by`]: String(body.updatedBy).slice(
              0,
              200,
            ),
          }
        : {}),
    };

    if (contentType === "overview") {
      const existing = parseOverviewMap(product.metadata?.[metadataKey]);
      const fup_notice = String(body.fup_notice ?? "").trim();
      const activation_notice = String(body.activation_notice ?? "").trim();

      if (fup_notice || activation_notice) {
        existing[carrier] = {
          ...(fup_notice ? { fup_notice } : {}),
          ...(activation_notice ? { activation_notice } : {}),
        };
      } else {
        delete existing[carrier];
      }

      metadata[metadataKey] = JSON.stringify(existing);
      responsePayload[metadataKey] = existing;
    } else {
      const existing = parseContentMap(product.metadata?.[metadataKey]);
      if (html.trim()) {
        existing[carrier] = html;
      } else {
        delete existing[carrier];
      }

      metadata[metadataKey] = JSON.stringify(existing);
      responsePayload[metadataKey] = existing;
    }

    await updateProductsWorkflow(req.scope).run({
      input: {
        products: [{ id: productId, metadata }],
      },
    });

    return res.status(200).json(responsePayload);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[internal/product-content]", message);
    return res.status(500).json({ error: "更新失敗", detail: message });
  }
}
