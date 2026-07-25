import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { updateProductVariantsWorkflow } from "@medusajs/medusa/core-flows";

/**
 * 將 china-unlimited-esim 的 *-B0 變體售價改為成本 × 1.45（約 45% 利潤）
 * 公式與選號台一致：Math.ceil((cost * 1.45) / 10) * 10 - 1
 *
 * 執行：npx medusa exec ./src/scripts/reprice-china-unlimited-b0-45.ts
 */

const HANDLE = "china-unlimited-esim";
const MARGIN = 1.45;

const COST_BY_SKU: Record<string, number> = {
  "China-unlimited-1-B0": 64,
  "China-unlimited-2-B0": 119,
  "China-unlimited-3-B0": 171,
  "China-unlimited-4-B0": 227,
  "China-unlimited-5-B0": 284,
  "China-unlimited-6-B0": 341,
  "China-unlimited-7-B0": 382,
  "China-unlimited-8-B0": 436,
  "China-unlimited-9-B0": 491,
  "China-unlimited-10-B0": 546,
  "China-unlimited-12-B0": 654,
  "China-unlimited-15-B0": 818,
  "China-unlimited-20-B0": 1090,
  "China-unlimited-25-B0": 1408,
  "China-unlimited-30-B0": 1635,
};

function retailFromCost(costTwd: number) {
  return Math.ceil((costTwd * MARGIN) / 10) * 10 - 1;
}

export default async function repriceChinaUnlimitedB045({
  container,
}: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  const { data: products } = await query.graph({
    entity: "product",
    fields: ["id", "handle", "variants.id", "variants.sku", "variants.metadata"],
    filters: { handle: HANDLE },
  });

  if (!products?.length) {
    throw new Error(`找不到商品 handle=${HANDLE}`);
  }

  const product = products[0] as {
    id: string;
    variants?: Array<{
      id: string;
      sku?: string | null;
      metadata?: Record<string, unknown> | null;
    }>;
  };

  const updates: Array<{
    id: string;
    prices: Array<{ amount: number; currency_code: string }>;
    metadata: Record<string, unknown>;
  }> = [];

  for (const v of product.variants || []) {
    const sku = v.sku || "";
    const cost = COST_BY_SKU[sku];
    if (cost == null) continue;

    const retail = retailFromCost(cost);
    const prevMeta =
      v.metadata && typeof v.metadata === "object" ? { ...v.metadata } : {};

    updates.push({
      id: v.id,
      prices: [{ amount: retail, currency_code: "twd" }],
      metadata: {
        ...prevMeta,
        cost_price: cost,
        margin: MARGIN,
        profit_rate: "45%",
      },
    });

    logger.info(`${sku}: 成本 ${cost} → 售價 TWD ${retail}（45%）`);
  }

  if (!updates.length) {
    throw new Error("找不到任何 *-B0 變體可調價");
  }

  await updateProductVariantsWorkflow(container).run({
    input: { product_variants: updates },
  });

  logger.info(`已更新 ${updates.length} 個變體為 45% 利潤`);
}
