import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import {
  createProductVariantsWorkflow,
  updateProductsWorkflow,
} from "@medusajs/medusa/core-flows";

/**
 * 為 china-unlimited-esim 補齊「支援 GPT／TikTok」的吃到飽天數變體（僅 *-B0）
 *
 * 來源依據：
 * - SKU / plan_id：esim-store-front/lib/esim/planMap.ts
 * - 售價：成本 × 1.45（約 45% 利潤），尾數 9
 * - 排除 *-A0（香港 IP，GPT／TikTok ❌）
 *
 * 執行：npx medusa exec ./src/scripts/add-china-unlimited-b0-variants.ts
 */

const HANDLE = "china-unlimited-esim";
const TELECOM = "CMCC+";
const DATA_AMOUNT = "吃到飽";
const LINE = "漫遊線路";
const MARGIN = 1.45;

function retailFromCost(costTwd: number) {
  return Math.ceil((costTwd * MARGIN) / 10) * 10 - 1;
}

/** 僅 GPT ✅ TikTok ✅（Singapore IP / zonginternet） */
const B0_PLANS: Array<{
  days: number;
  sku: string;
  planId: string;
  costTwd: number;
  retailTwd: number;
}> = [
  // 1 天已建立，腳本會跳過既有 SKU
  {
    days: 1,
    sku: "China-unlimited-1-B0",
    planId: "f2abfbeb-a8b2-4b9d-8bfd-d8afa59d6c32",
    costTwd: 64,
    retailTwd: retailFromCost(64),
  },
  {
    days: 2,
    sku: "China-unlimited-2-B0",
    planId: "c820fb6f-36d2-471d-adf6-1a167119ab34",
    costTwd: 119,
    retailTwd: retailFromCost(119),
  },
  {
    days: 3,
    sku: "China-unlimited-3-B0",
    planId: "10f881f6-14f2-4d29-9fca-d8daed365951",
    costTwd: 171,
    retailTwd: retailFromCost(171),
  },
  {
    days: 4,
    sku: "China-unlimited-4-B0",
    planId: "00b59533-a04e-4cac-819d-597698f82c31",
    costTwd: 227,
    retailTwd: retailFromCost(227),
  },
  {
    days: 5,
    sku: "China-unlimited-5-B0",
    planId: "1922a825-ffb1-4a62-a4b0-73f6ef918da1",
    costTwd: 284,
    retailTwd: retailFromCost(284),
  },
  {
    days: 6,
    sku: "China-unlimited-6-B0",
    planId: "9b9d84f9-8692-40d6-b976-249377715433",
    costTwd: 341,
    retailTwd: retailFromCost(341),
  },
  {
    days: 7,
    sku: "China-unlimited-7-B0",
    planId: "929e326d-0491-4200-b482-9946cc58c97b",
    costTwd: 382,
    retailTwd: retailFromCost(382),
  },
  {
    days: 8,
    sku: "China-unlimited-8-B0",
    planId: "394beb34-8735-4bb0-9707-22e0bb482052",
    costTwd: 436,
    retailTwd: retailFromCost(436),
  },
  {
    days: 9,
    sku: "China-unlimited-9-B0",
    planId: "2222d9e5-d677-4e05-b37b-b4267c219e22",
    costTwd: 491,
    retailTwd: retailFromCost(491),
  },
  {
    days: 10,
    sku: "China-unlimited-10-B0",
    planId: "9f36247b-02ac-449e-aa68-9ef618df5941",
    costTwd: 546,
    retailTwd: retailFromCost(546),
  },
  {
    days: 12,
    sku: "China-unlimited-12-B0",
    planId: "f1b7bfd5-5c97-49a2-ab23-85332a85d6e2",
    costTwd: 654,
    retailTwd: retailFromCost(654),
  },
  {
    days: 15,
    sku: "China-unlimited-15-B0",
    planId: "88153b3f-afc4-44d1-ad95-c414536abdb5",
    costTwd: 818,
    retailTwd: retailFromCost(818),
  },
  {
    days: 20,
    sku: "China-unlimited-20-B0",
    planId: "9fd5726b-10ef-4dbf-9b49-7cda8de3287b",
    costTwd: 1090,
    retailTwd: retailFromCost(1090),
  },
  {
    days: 25,
    sku: "China-unlimited-25-B0",
    planId: "57ba87a7-2c9e-40bb-9b30-8874306bd708",
    costTwd: 1408,
    retailTwd: retailFromCost(1408),
  },
  {
    days: 30,
    sku: "China-unlimited-30-B0",
    planId: "2463e6c8-ee71-4db4-ae12-236262bb0c67",
    costTwd: 1635,
    retailTwd: retailFromCost(1635),
  },
];

function dayLabel(days: number) {
  return `${days}天`;
}

export default async function addChinaUnlimitedB0Variants({
  container,
}: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  const { data: products } = await query.graph({
    entity: "product",
    fields: [
      "id",
      "title",
      "handle",
      "options.id",
      "options.title",
      "options.values.id",
      "options.values.value",
      "variants.id",
      "variants.sku",
      "variants.title",
    ],
    filters: { handle: HANDLE },
  });

  if (!products?.length) {
    throw new Error(`找不到商品 handle=${HANDLE}，請先建立商品`);
  }

  const product = products[0] as {
    id: string;
    title: string;
    options?: Array<{
      id: string;
      title: string;
      values?: Array<{ id: string; value: string }>;
    }>;
    variants?: Array<{ id: string; sku?: string | null; title?: string }>;
  };

  const existingSkus = new Set(
    (product.variants || []).map((v) => v.sku).filter(Boolean) as string[],
  );

  const dayOption = product.options?.find((o) => o.title === "使用天數");
  if (!dayOption) {
    throw new Error("商品缺少「使用天數」option");
  }

  const allDayValues = B0_PLANS.map((p) => dayLabel(p.days));
  const existingDayValues = new Set(
    (dayOption.values || []).map((v) => v.value),
  );
  const mergedDayValues = Array.from(
    new Set([...existingDayValues, ...allDayValues]),
  ).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

  // 確保其他 option 值存在（電信商／數據量／線路）
  const optionUpdates = (product.options || []).map((opt) => {
    if (opt.title === "使用天數") {
      return { id: opt.id, title: opt.title, values: mergedDayValues };
    }
    const current = (opt.values || []).map((v) => v.value);
    let required: string[] = [];
    if (opt.title === "電信商") required = [TELECOM];
    if (opt.title === "數據量") required = [DATA_AMOUNT];
    if (opt.title === "線路") required = [LINE];
    return {
      id: opt.id,
      title: opt.title,
      values: Array.from(new Set([...current, ...required])),
    };
  });

  await updateProductsWorkflow(container).run({
    input: {
      products: [
        {
          id: product.id,
          options: optionUpdates,
        },
      ],
    },
  });

  logger.info(
    `已更新使用天數 options：${mergedDayValues.join(", ")}`,
  );

  const toCreate = B0_PLANS.filter((p) => !existingSkus.has(p.sku));

  if (!toCreate.length) {
    logger.info("所有 B0 變體已存在，無需新增");
    return;
  }

  const product_variants = toCreate.map((p) => {
    const days = dayLabel(p.days);
    return {
      product_id: product.id,
      title: `${TELECOM} · ${days} · ${DATA_AMOUNT}`,
      sku: p.sku,
      manage_inventory: false,
      options: {
        使用天數: days,
        數據量: DATA_AMOUNT,
        電信商: TELECOM,
        線路: LINE,
      },
      prices: [{ amount: p.retailTwd, currency_code: "twd" }],
      metadata: {
        plan_id: p.planId,
        cost_price: p.costTwd,
        attributes: {
          days: p.days,
          data: DATA_AMOUNT,
          data_amount: DATA_AMOUNT,
          telecom: TELECOM,
          line: LINE,
          network: "5G 極速",
          ip_type: "新加坡 IP",
          hotspot: true,
          gpt: true,
          tiktok: true,
          gemini: true,
        },
      },
    };
  });

  const { result } = await createProductVariantsWorkflow(container).run({
    input: { product_variants },
  });

  logger.info(
    `已新增 ${result.length} 個變體（僅 GPT/TikTok 支援的 *-B0）：`,
  );
  for (const p of toCreate) {
    logger.info(
      `  ${p.sku} · ${dayLabel(p.days)} · plan_id=${p.planId} · TWD ${p.retailTwd}（成本 ${p.costTwd}）`,
    );
  }
  logger.info(
    `略過既有 SKU：${[...existingSkus].filter((s) => s?.endsWith("-B0")).join(", ") || "(無)"}`,
  );
}
