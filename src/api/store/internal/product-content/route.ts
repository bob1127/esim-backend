import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Modules } from "@medusajs/framework/utils";
import { updateProductsWorkflow } from "@medusajs/core-flows";

// 注意：分潤％／旅客折扣％（partner_terms）已改由 Medusa 原生管理員 API
// （/admin/product-partner-terms，見 src/api/admin/product-partner-terms/route.ts
// 與 src/admin/widgets/product-partner-terms.tsx）設定，不再開放於這支
// 對外公開的 /store 端點——避免共用密鑰外洩就能竄改分潤／折扣的風險。
const CONTENT_METADATA_KEYS = {
  detailed: "detailed_content_by_carrier",
  usage: "usage_content_by_carrier",
  faq: "faq_content_by_carrier",
  overview: "overview_notices_by_carrier",
  promo: "promo_offer_by_carrier",
  features: "key_features_by_carrier",
  specs: "carrier_specs_by_carrier",
  profit: "carrier_profit_by_carrier",
  subtitle: "subtitle_by_carrier",
} as const;

type HtmlContentType = "detailed" | "usage" | "faq";
type ContentType =
  | HtmlContentType
  | "overview"
  | "promo"
  | "features"
  | "specs"
  | "profit"
  | "subtitle";

function resolveContentType(raw: unknown): ContentType {
  if (raw === "usage") return "usage";
  if (raw === "faq") return "faq";
  if (raw === "overview") return "overview";
  if (raw === "promo") return "promo";
  if (raw === "features") return "features";
  if (raw === "specs") return "specs";
  if (raw === "profit") return "profit";
  if (raw === "subtitle") return "subtitle";
  return "detailed";
}

function parseJsonObjectMap(raw: unknown): Record<string, unknown> {
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
  return { ...(data as Record<string, unknown>) };
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

type PromoOffer = {
  enabled?: boolean;
  code?: string;
  discount_type?: "percent" | "fixed";
  discount_value?: number;
  message?: string;
};

function parsePromoMap(raw: unknown): Record<string, PromoOffer> {
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

  const out: Record<string, PromoOffer> = {};
  for (const [carrier, offer] of Object.entries(
    data as Record<string, unknown>,
  )) {
    if (!offer || typeof offer !== "object" || Array.isArray(offer)) continue;
    const obj = offer as Record<string, unknown>;
    const code = String(obj.code ?? "").trim().toUpperCase();
    const message = String(obj.message ?? "").trim();
    const enabled = Boolean(obj.enabled ?? obj.active ?? false);
    const discount_type =
      obj.discount_type === "fixed" || obj.discountType === "fixed"
        ? "fixed"
        : "percent";
    const rawValue = Number(
      obj.discount_value ?? obj.discountValue ?? obj.amount ?? 0,
    );
    const discount_value = Number.isFinite(rawValue)
      ? Math.max(0, rawValue)
      : 0;

    if (code || message || enabled) {
      out[carrier] = {
        enabled,
        code,
        discount_type,
        discount_value,
        ...(message ? { message } : {}),
      };
    }
  }
  return out;
}

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
    enabled?: boolean;
    code?: string;
    discount_type?: string;
    discount_value?: number;
    message?: string;
    features?: unknown;
    specs?: unknown;
    profit_percent?: unknown;
    subtitle?: unknown;
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

  if (
    contentType !== "overview" &&
    contentType !== "promo" &&
    contentType !== "features" &&
    contentType !== "specs" &&
    contentType !== "profit" &&
    contentType !== "subtitle" &&
    html.length > 200_000
  ) {
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
    } else if (contentType === "promo") {
      const existing = parsePromoMap(product.metadata?.[metadataKey]);
      const code = String(body.code ?? "").trim().toUpperCase();
      const message = String(body.message ?? "").trim();
      const enabled = Boolean(body.enabled);
      const discount_type =
        body.discount_type === "fixed" ? "fixed" : "percent";
      const rawValue = Number(body.discount_value ?? 0);
      const discount_value = Number.isFinite(rawValue)
        ? Math.max(0, rawValue)
        : 0;

      if (code || message) {
        existing[carrier] = {
          enabled,
          code,
          discount_type,
          discount_value,
          ...(message ? { message } : {}),
        };
      } else {
        delete existing[carrier];
      }

      metadata[metadataKey] = JSON.stringify(existing);
      responsePayload[metadataKey] = existing;
    } else if (contentType === "features") {
      const existing = parseJsonObjectMap(product.metadata?.[metadataKey]);
      const list = Array.isArray(body.features)
        ? body.features.map((x) => String(x ?? "").trim()).filter(Boolean)
        : [];
      if (list.length) existing[carrier] = list;
      else delete existing[carrier];
      metadata[metadataKey] = JSON.stringify(existing);
      responsePayload[metadataKey] = existing;
    } else if (contentType === "specs") {
      const existing = parseJsonObjectMap(product.metadata?.[metadataKey]);
      const specs =
        body.specs && typeof body.specs === "object" && !Array.isArray(body.specs)
          ? (body.specs as Record<string, unknown>)
          : null;
      if (specs && Object.keys(specs).length) existing[carrier] = specs;
      else delete existing[carrier];
      metadata[metadataKey] = JSON.stringify(existing);
      responsePayload[metadataKey] = existing;
    } else if (contentType === "profit") {
      const existing = parseJsonObjectMap(product.metadata?.[metadataKey]);
      const n = Number(body.profit_percent);
      if (Number.isFinite(n) && n > 0) existing[carrier] = n;
      else delete existing[carrier];
      metadata[metadataKey] = JSON.stringify(existing);
      responsePayload[metadataKey] = existing;
    } else if (contentType === "subtitle") {
      const existing = parseJsonObjectMap(product.metadata?.[metadataKey]);
      const subtitle = String(body.subtitle ?? "").trim();
      if (subtitle) existing[carrier] = subtitle;
      else delete existing[carrier];
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
