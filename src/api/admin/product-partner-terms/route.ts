import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Modules } from "@medusajs/framework/utils";
import { updateProductsWorkflow } from "@medusajs/core-flows";

/**
 * 專屬連結夥伴「分潤％／旅客折扣％」設定 API。
 *
 * 安全設計：此路由位於 /admin/* 之下，由 Medusa 內建管理員驗證中介層
 * 自動保護（需登入 Medusa 後台的管理員帳號，Bearer/Session 皆可），
 * 不是對外公開的 /store 端點，也不依賴任何共用密鑰——
 * 只有實際登入 Medusa Admin 的人員才能呼叫。
 */

const PARTNER_RATE_KEY = "carrier_partner_rate_by_carrier";
const REFERRAL_DISCOUNT_KEY = "carrier_referral_discount_by_carrier";
const TELECOM_OPTION_TITLES = ["電信商", "telecom", "carrier"];

function parsePercentMap(raw: unknown): Record<string, number> {
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

  const out: Record<string, number> = {};
  for (const [carrier, value] of Object.entries(
    data as Record<string, unknown>,
  )) {
    const n = Number(String(value).replace("%", "").trim());
    if (Number.isFinite(n) && n >= 0) out[String(carrier).trim()] = n;
  }
  return out;
}

type ProductWithOptions = {
  id: string;
  metadata?: Record<string, unknown> | null;
  options?: Array<{
    title?: string | null;
    values?: Array<{ value?: string | null }>;
  }> | null;
};

function resolveCarriersFromProduct(product: ProductWithOptions): string[] {
  const opt = (product.options || []).find((o) =>
    TELECOM_OPTION_TITLES.some(
      (t) => String(o.title || "").trim().toLowerCase() === t.toLowerCase(),
    ),
  );
  if (!opt) return [];
  return Array.from(
    new Set(
      (opt.values || [])
        .map((v) => String(v.value || "").trim())
        .filter(Boolean),
    ),
  );
}

/**
 * GET /admin/product-partner-terms?product_id=xxx
 * 回傳該商品可用電信商清單（依「電信商」選項值）＋目前分潤／折扣設定。
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const productId = String(req.query.product_id || "").trim();
  if (!productId) {
    return res.status(400).json({ error: "缺少 product_id" });
  }

  try {
    const productModule = req.scope.resolve(Modules.PRODUCT) as {
      retrieveProduct: (
        id: string,
        config?: Record<string, unknown>,
      ) => Promise<ProductWithOptions>;
    };

    const product = await productModule.retrieveProduct(productId, {
      relations: ["options", "options.values"],
    });
    if (!product?.id) {
      return res.status(404).json({ error: "找不到商品" });
    }

    const carriers = resolveCarriersFromProduct(product);
    const rateMap = parsePercentMap(product.metadata?.[PARTNER_RATE_KEY]);
    const discountMap = parsePercentMap(
      product.metadata?.[REFERRAL_DISCOUNT_KEY],
    );

    return res.status(200).json({
      product_id: productId,
      carriers,
      carrier_partner_rate_by_carrier: rateMap,
      carrier_referral_discount_by_carrier: discountMap,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ error: "讀取失敗", detail: message });
  }
}

/**
 * POST /admin/product-partner-terms
 * body: { product_id, carrier, partner_rate_percent, referral_discount_percent }
 * 傳 null／空字串代表清除該電信商的設定。
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const body = (req.body || {}) as {
    product_id?: string;
    carrier?: string;
    partner_rate_percent?: unknown;
    referral_discount_percent?: unknown;
  };

  const productId = String(body.product_id || "").trim();
  const carrier = String(body.carrier || "").trim();

  if (!productId || !carrier) {
    return res.status(400).json({ error: "缺少 product_id 或 carrier" });
  }
  if (carrier.length > 120) {
    return res.status(400).json({ error: "carrier 名稱過長" });
  }

  const hasRate =
    body.partner_rate_percent !== "" && body.partner_rate_percent != null;
  const hasDiscount =
    body.referral_discount_percent !== "" &&
    body.referral_discount_percent != null;

  const rate = Number(body.partner_rate_percent);
  const discount = Number(body.referral_discount_percent);

  if (hasRate && (!Number.isFinite(rate) || rate < 0 || rate > 100)) {
    return res.status(400).json({ error: "分潤趴數需為 0–100" });
  }
  if (hasDiscount && (!Number.isFinite(discount) || discount < 0 || discount > 50)) {
    return res.status(400).json({ error: "折扣趴數需為 0–50" });
  }

  try {
    const productModule = req.scope.resolve(Modules.PRODUCT) as {
      retrieveProduct: (
        id: string,
        config?: Record<string, unknown>,
      ) => Promise<ProductWithOptions>;
    };

    const product = await productModule.retrieveProduct(productId, {
      relations: ["options", "options.values"],
    });
    if (!product?.id) {
      return res.status(404).json({ error: "找不到商品" });
    }

    const rateMap = parsePercentMap(product.metadata?.[PARTNER_RATE_KEY]);
    const discountMap = parsePercentMap(
      product.metadata?.[REFERRAL_DISCOUNT_KEY],
    );

    if (hasRate && rate > 0) rateMap[carrier] = rate;
    else delete rateMap[carrier];

    if (hasDiscount && discount > 0) discountMap[carrier] = discount;
    else delete discountMap[carrier];

    const metadata: Record<string, unknown> = {
      ...(product.metadata || {}),
      [PARTNER_RATE_KEY]: JSON.stringify(rateMap),
      [REFERRAL_DISCOUNT_KEY]: JSON.stringify(discountMap),
      partner_terms_updated_at: new Date().toISOString(),
    };

    await updateProductsWorkflow(req.scope).run({
      input: {
        products: [{ id: productId, metadata }],
      },
    });

    return res.status(200).json({
      success: true,
      product_id: productId,
      carrier,
      carrier_partner_rate_by_carrier: rateMap,
      carrier_referral_discount_by_carrier: discountMap,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ error: "儲存失敗", detail: message });
  }
}
