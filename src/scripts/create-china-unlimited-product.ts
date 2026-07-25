import { ExecArgs } from "@medusajs/framework/types";
import {
  ContainerRegistrationKeys,
  Modules,
  ProductStatus,
} from "@medusajs/framework/utils";
import { createProductsWorkflow } from "@medusajs/medusa/core-flows";

/**
 * 建立「中國大陸無限流量吃到飽eSIM」+ 1 天變體（示範用）
 * 執行：npx medusa exec ./src/scripts/create-china-unlimited-product.ts
 */
export default async function createChinaUnlimitedProduct({
  container,
}: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const salesChannelModule = container.resolve(Modules.SALES_CHANNEL);
  const fulfillmentModule = container.resolve(Modules.FULFILLMENT);

  const handle = "china-unlimited-esim";

  const { data: existing } = await query.graph({
    entity: "product",
    fields: ["id", "handle", "title"],
    filters: { handle },
  });

  if (existing?.length) {
    logger.info(
      `商品已存在：${existing[0].title} (${existing[0].id}) handle=${handle}`,
    );
    return;
  }

  let salesChannels = await salesChannelModule.listSalesChannels({
    name: "Default Sales Channel",
  });
  if (!salesChannels.length) {
    salesChannels = await salesChannelModule.listSalesChannels({}, { take: 1 });
  }
  if (!salesChannels.length) {
    throw new Error("找不到 Sales Channel，請先完成商店初始化");
  }

  const shippingProfiles = await fulfillmentModule.listShippingProfiles(
    {},
    { take: 1 },
  );
  const shippingProfileId = shippingProfiles[0]?.id;

  const telecom = "CMCC+";
  const days = "1天";
  const dataAmount = "吃到飽";
  const line = "漫遊線路";
  const sku = "China-unlimited-1-B0";
  const planId = "f2abfbeb-a8b2-4b9d-8bfd-d8afa59d6c32";
  const retailPrice = 99; // 成本 64 × 1.45 ≈ 45% 利潤

  const productPayload: Record<string, unknown> = {
    title: "中國大陸 eSIM – 支援 TikTok 與 ChatGPT",
    subtitle: "漫遊線路・CMCC+・5G 極速・支援熱點",
    handle,
    description:
      "中國大陸漫遊吃到飽 eSIM（FUP）。CMCC+ 線路、5G 極速、支援熱點；可用 GPT／TikTok／Gemini。新加坡 IP、自動設定。",
    status: ProductStatus.PUBLISHED,
    sales_channels: [{ id: salesChannels[0].id }],
    options: [
      { title: "使用天數", values: [days] },
      { title: "數據量", values: [dataAmount] },
      { title: "電信商", values: [telecom] },
      { title: "線路", values: [line] },
    ],
    metadata: {
      carrier_specs_by_carrier: {
        [telecom]: {
          ip_type: "新加坡 IP",
          route_type: line,
          network: "CMCC+ / 5G 極速",
          speed_rule: "無限流量 (FUP)・自動設定",
          apps: {
            gpt: true,
            tiktok: true,
            gemini: true,
            hotspot: true,
          },
          server: "zonginternet",
        },
      },
      hot_sale_telecoms: [telecom],
      overview_notices_by_carrier: {
        [telecom]: {
          fup_notice: "無限流量（FUP 公平使用政策）",
          activation_notice: "自動設定開通",
        },
      },
    },
    variants: [
      {
        title: `${telecom} · ${days} · ${dataAmount}`,
        sku,
        manage_inventory: false,
        options: {
          使用天數: days,
          數據量: dataAmount,
          電信商: telecom,
          線路: line,
        },
        prices: [{ amount: retailPrice, currency_code: "twd" }],
        metadata: {
          plan_id: planId,
          cost_price: 64,
          attributes: {
            days: 1,
            data: dataAmount,
            data_amount: dataAmount,
            telecom,
            line,
            network: "5G 極速",
            ip_type: "新加坡 IP",
            hotspot: true,
          },
        },
      },
    ],
  };

  if (shippingProfileId) {
    productPayload.shipping_profile_id = shippingProfileId;
  }

  const { result } = await createProductsWorkflow(container).run({
    input: { products: [productPayload as any] },
  });

  const created = result?.[0];
  logger.info(
    `已建立：${created?.title} id=${created?.id} handle=${created?.handle}`,
  );
  logger.info(
    `變體：${sku} / plan_id=${planId} / 售價 TWD ${retailPrice}`,
  );
}
