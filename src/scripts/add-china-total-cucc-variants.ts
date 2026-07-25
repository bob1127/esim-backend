import { readFileSync } from "fs";
import { join } from "path";
import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import {
  createProductVariantsWorkflow,
  updateProductsWorkflow,
} from "@medusajs/medusa/core-flows";

/**
 * 匯入中國聯通 CUCC 總量型（新加坡 IP／e-ideas，50% 利潤）
 * 並寫入 carrier_profit_by_carrier 方便後台辨識各電信商利潤
 *
 * 執行：npx medusa exec ./src/scripts/add-china-total-cucc-variants.ts
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
const LINE = "漫遊線路";
const CARRIER_CUCC = "中國聯通";
const CARRIER_STD = "中國移動";
const CARRIER_GPT = "中國移動 GPT + TikTok";

function loadPlans(): PlanRow[] {
  const file = join(__dirname, "data", "china-total-cucc-plans.json");
  return JSON.parse(readFileSync(file, "utf8")) as PlanRow[];
}

export default async function addChinaTotalCuccVariants({
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
      "metadata",
      "options.id",
      "options.title",
      "options.values.value",
      "variants.id",
      "variants.sku",
    ],
    filters: { handle: HANDLE },
  });

  if (!products?.length) {
    throw new Error(`找不到商品 handle=${HANDLE}`);
  }

  const product = products[0] as any;
  const plans = loadPlans();
  const existingSkus = new Set(
    (product.variants || []).map((v: any) => v.sku).filter(Boolean),
  );

  const dayValues = new Set<string>();
  const dataValues = new Set<string>();
  const telecomValues = new Set<string>([
    CARRIER_STD,
    CARRIER_GPT,
    CARRIER_CUCC,
  ]);

  for (const opt of product.options || []) {
    if (opt.title === "使用天數") {
      for (const v of opt.values || []) dayValues.add(v.value);
    }
    if (opt.title === "數據量") {
      for (const v of opt.values || []) dataValues.add(v.value);
    }
    if (opt.title === "電信商") {
      for (const v of opt.values || []) telecomValues.add(v.value);
    }
  }
  for (const p of plans) {
    dayValues.add(`${p.days}天`);
    dataValues.add(`${p.gb}GB`);
  }

  const prevMeta =
    product.metadata && typeof product.metadata === "object"
      ? { ...product.metadata }
      : {};

  const prevSpecs =
    prevMeta.carrier_specs_by_carrier &&
    typeof prevMeta.carrier_specs_by_carrier === "object"
      ? { ...prevMeta.carrier_specs_by_carrier }
      : {};

  const prevNotices =
    prevMeta.overview_notices_by_carrier &&
    typeof prevMeta.overview_notices_by_carrier === "object"
      ? { ...prevMeta.overview_notices_by_carrier }
      : {};

  const optionUpdates = (product.options || []).map((opt: any) => {
    if (opt.title === "電信商") {
      return {
        id: opt.id,
        title: opt.title,
        values: Array.from(telecomValues),
      };
    }
    if (opt.title === "使用天數") {
      return {
        id: opt.id,
        title: opt.title,
        values: Array.from(dayValues).sort(
          (a, b) => parseInt(a, 10) - parseInt(b, 10),
        ),
      };
    }
    if (opt.title === "數據量") {
      return {
        id: opt.id,
        title: opt.title,
        values: Array.from(dataValues).sort(
          (a, b) => parseInt(a, 10) - parseInt(b, 10),
        ),
      };
    }
    if (opt.title === "線路") {
      const vals = new Set((opt.values || []).map((v: any) => v.value));
      vals.add(LINE);
      return { id: opt.id, title: opt.title, values: Array.from(vals) };
    }
    return {
      id: opt.id,
      title: opt.title,
      values: (opt.values || []).map((v: any) => v.value),
    };
  });

  await updateProductsWorkflow(container).run({
    input: {
      products: [
        {
          id: product.id,
          options: optionUpdates,
          metadata: {
            ...prevMeta,
            /** 各電信商建議售價利潤％（後台／前台電信商旁顯示用） */
            carrier_profit_by_carrier: {
              [CARRIER_STD]: 45,
              [CARRIER_GPT]: 45,
              [CARRIER_CUCC]: 50,
            },
            hot_sale_telecoms: [CARRIER_GPT],
            carrier_specs_by_carrier: {
              ...prevSpecs,
              [CARRIER_CUCC]: {
                ip_type: "新加坡IP",
                route_type: "漫遊",
                network: "5G/4G",
              },
            },
            overview_notices_by_carrier: {
              ...prevNotices,
              [CARRIER_CUCC]: {
                fup_notice:
                  "用量總計型：中國聯通線路；新加坡 IP，支援 GPT／TikTok／Gemini",
                activation_notice: "e-ideas APN・自動設定開通",
              },
            },
          },
        },
      ],
    },
  });
  logger.info("已更新電信商 options／利潤表／CUCC 規格");

  const toCreate = plans.filter((p) => !existingSkus.has(p.sku));
  if (!toCreate.length) {
    logger.info("CUCC 變體皆已存在，僅更新 metadata");
    return;
  }

  const product_variants = toCreate.map((p) => {
    const days = `${p.days}天`;
    const dataAmount = `${p.gb}GB`;
    return {
      product_id: product.id,
      title: `${CARRIER_CUCC} · ${days} · ${dataAmount}`,
      sku: p.sku,
      manage_inventory: false,
      options: {
        使用天數: days,
        數據量: dataAmount,
        電信商: CARRIER_CUCC,
        線路: LINE,
      },
      prices: [{ amount: p.retailTwd, currency_code: "twd" }],
      metadata: {
        plan_id: p.planId,
        cost_price: p.costTwd,
        margin: 1.5,
        profit_rate: "50%",
        attributes: {
          days: p.days,
          data: dataAmount,
          data_amount: dataAmount,
          telecom: CARRIER_CUCC,
          line: LINE,
          network: "5G/4G",
          ip_type: "新加坡IP",
          hotspot: true,
          gpt: true,
          tiktok: true,
          gemini: true,
          plan_type: "total",
          carrier_code: "CUCC",
        },
      },
    };
  });

  const { result } = await createProductVariantsWorkflow(container).run({
    input: { product_variants },
  });

  logger.info(
    `已新增 ${result.length} 個中國聯通 CUCC 變體（50% 利潤）`,
  );
  logger.info(
    `範例：${toCreate[0].sku} 成本 ${toCreate[0].costTwd} → 售價 ${toCreate[0].retailTwd}`,
  );
}
