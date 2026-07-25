import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { updateProductsWorkflow } from "@medusajs/medusa/core-flows";

/**
 * 為 china-total-esim 補上各電信商「支援：熱點／App」規格（對齊日本商品頁）
 * 執行：npx medusa exec ./src/scripts/update-china-total-apps-specs.ts
 */
export default async function updateChinaTotalAppsSpecs({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  const { data } = await query.graph({
    entity: "product",
    fields: ["id", "metadata"],
    filters: { handle: "china-total-esim" },
  });

  if (!data?.length) {
    throw new Error("找不到 china-total-esim");
  }

  const product = data[0] as { id: string; metadata?: Record<string, unknown> };
  const prev = (product.metadata || {}) as Record<string, any>;
  const specs = { ...(prev.carrier_specs_by_carrier || {}) };

  specs["中國移動"] = {
    ...(specs["中國移動"] || {}),
    ip_type: "香港IP",
    route_type: "漫遊",
    network: "5G/4G",
    apps: "熱點分享",
  };

  specs["中國移動 GPT + TikTok"] = {
    ...(specs["中國移動 GPT + TikTok"] || {}),
    ip_type: "新加坡IP",
    route_type: "漫遊",
    network: "5G/4G",
    apps: "熱點分享,ChatGPT,TikTok",
  };

  specs["中國聯通"] = {
    ...(specs["中國聯通"] || {}),
    ip_type: "新加坡IP",
    route_type: "漫遊",
    network: "5G/4G",
    apps: "熱點分享,ChatGPT,TikTok",
  };

  await updateProductsWorkflow(container).run({
    input: {
      products: [
        {
          id: product.id,
          metadata: {
            ...prev,
            carrier_specs_by_carrier: specs,
          },
        },
      ],
    },
  });

  logger.info("已更新中國總計型 carrier_specs.apps（熱點／App 支援）");
}
