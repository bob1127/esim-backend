import { readFileSync } from "fs";
import { join } from "path";
import { ExecArgs } from "@medusajs/framework/types";
import {
  ContainerRegistrationKeys,
  Modules,
  ProductStatus,
} from "@medusajs/framework/utils";
import {
  createProductsWorkflow,
  updateProductsWorkflow,
} from "@medusajs/medusa/core-flows";

/**
 * 建立「中國大陸 eSIM 總計型」（僅 GPT／TikTok 支援的 *-B0，45% 利潤）
 *
 * 標題層級：
 * - 主標：中國大陸 eSIM 總計型
 * - 副標：支援 TikTok 與 ChatGPT
 * - 變體：CMCC+ · X天 · YGB
 *
 * 執行：npx medusa exec ./src/scripts/create-china-total-product.ts
 */

type PlanRow = {
  sku: string;
  planId: string;
  gb: number;
  days: number;
  costTwd: number;
  retailTwd: number;
};

const HANDLE = "china-total-esim";
const TELECOM = "CMCC+";
const LINE = "漫遊線路";
const CHINA_CATEGORY_ID = "pcat_01KY70EGV51W6NNHWBFGX3VZ1F";
// 注意：上線後請再跑 upgrade-china-total-carriers.ts
// 將電信商拆成「中國移動」+「中國移動 GPT + TikTok」

function loadPlans(): PlanRow[] {
  const file = join(__dirname, "data", "china-total-b0-plans.json");
  return JSON.parse(readFileSync(file, "utf8")) as PlanRow[];
}

export default async function createChinaTotalProduct({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const salesChannelModule = container.resolve(Modules.SALES_CHANNEL);
  const fulfillmentModule = container.resolve(Modules.FULFILLMENT);

  const { data: existing } = await query.graph({
    entity: "product",
    fields: ["id", "handle", "title"],
    filters: { handle: HANDLE },
  });

  if (existing?.length) {
    logger.info(
      `商品已存在：${existing[0].title} (${existing[0].id}) handle=${HANDLE}`,
    );
    return;
  }

  const plans = loadPlans();
  if (!plans.length) {
    throw new Error("china-total-b0-plans.json 為空");
  }

  let salesChannels = await salesChannelModule.listSalesChannels({
    name: "Default Sales Channel",
  });
  if (!salesChannels.length) {
    salesChannels = await salesChannelModule.listSalesChannels({}, { take: 1 });
  }
  if (!salesChannels.length) {
    throw new Error("找不到 Sales Channel");
  }

  const shippingProfiles = await fulfillmentModule.listShippingProfiles(
    {},
    { take: 1 },
  );
  const shippingProfileId = shippingProfiles[0]?.id;

  const dayValues = Array.from(new Set(plans.map((p) => `${p.days}天`))).sort(
    (a, b) => parseInt(a, 10) - parseInt(b, 10),
  );
  const dataValues = Array.from(new Set(plans.map((p) => `${p.gb}GB`))).sort(
    (a, b) => parseInt(a, 10) - parseInt(b, 10),
  );

  const variants = plans.map((p) => {
    const days = `${p.days}天`;
    const dataAmount = `${p.gb}GB`;
    return {
      title: `${TELECOM} · ${days} · ${dataAmount}`,
      sku: p.sku,
      manage_inventory: false,
      options: {
        使用天數: days,
        數據量: dataAmount,
        電信商: TELECOM,
        線路: LINE,
      },
      prices: [{ amount: p.retailTwd, currency_code: "twd" }],
      metadata: {
        plan_id: p.planId,
        cost_price: p.costTwd,
        margin: 1.45,
        profit_rate: "45%",
        attributes: {
          days: p.days,
          data: dataAmount,
          data_amount: dataAmount,
          telecom: TELECOM,
          line: LINE,
          network: "5G 極速",
          ip_type: "新加坡 IP",
          hotspot: true,
          gpt: true,
          tiktok: true,
          gemini: true,
          plan_type: "total",
          speed_rule: "用完斷網",
        },
      },
    };
  });

  const productPayload: Record<string, unknown> = {
    title: "中國大陸 eSIM 總計型",
    subtitle: "支援 TikTok 與 ChatGPT",
    handle: HANDLE,
    description:
      "中國大陸漫遊用量總計型 eSIM。CMCC+ 線路、5G 極速、支援熱點；可用 GPT／TikTok／Gemini。新加坡 IP、流量用完即斷網、自動設定。",
    status: ProductStatus.PUBLISHED,
    sales_channels: [{ id: salesChannels[0].id }],
    options: [
      { title: "使用天數", values: dayValues },
      { title: "數據量", values: dataValues },
      { title: "電信商", values: [TELECOM] },
      { title: "線路", values: [LINE] },
    ],
    metadata: {
      product_type: "total",
      carrier_specs_by_carrier: {
        [TELECOM]: {
          ip_type: "新加坡 IP",
          route_type: LINE,
          network: "CMCC+ / 5G 極速",
          speed_rule: "用完斷網・自動設定",
          apps: {
            gpt: true,
            tiktok: true,
            gemini: true,
            hotspot: true,
          },
          server: "zonginternet",
        },
      },
      hot_sale_telecoms: [TELECOM],
      overview_notices_by_carrier: {
        [TELECOM]: {
          fup_notice: "用量總計型：流量用完即斷網",
          activation_notice: "自動設定開通",
        },
      },
    },
    variants,
  };

  if (shippingProfileId) {
    productPayload.shipping_profile_id = shippingProfileId;
  }

  const { result } = await createProductsWorkflow(container).run({
    input: { products: [productPayload as any] },
  });

  const created = result?.[0];
  if (!created?.id) {
    throw new Error("建立商品失敗");
  }

  // 掛到「中國」分類（與吃到飽商品同分類）
  try {
    await updateProductsWorkflow(container).run({
      input: {
        products: [
          {
            id: created.id,
            category_ids: [CHINA_CATEGORY_ID],
          },
        ],
      },
    });
    logger.info(`已加入分類 china (${CHINA_CATEGORY_ID})`);
  } catch (err) {
    logger.warn(
      `分類掛載失敗（商品已建立）：${err instanceof Error ? err.message : err}`,
    );
  }

  logger.info(
    `已建立：${created.title} id=${created.id} handle=${created.handle}`,
  );
  logger.info(
    `變體 ${variants.length} 個（僅 *-B0／GPT+TikTok／45%）：天數 ${dayValues.join(", ")}；流量 ${dataValues.join(", ")}`,
  );
  logger.info(
    `範例：${plans[0].sku} 成本 ${plans[0].costTwd} → 售價 ${plans[0].retailTwd}`,
  );
}
