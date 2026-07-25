import { readFileSync } from "fs";
import { join } from "path";
import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import {
  createProductVariantsWorkflow,
  updateProductVariantsWorkflow,
  updateProductsWorkflow,
} from "@medusajs/medusa/core-flows";

/**
 * 中國總計型：電信商拆成
 * - 中國移動（*-A0，不支援 GPT／TikTok）
 * - 中國移動 GPT + TikTok（既有 *-B0）
 * 並寫入圖二風格規格標籤（IP／漫遊／5G）
 *
 * 執行：npx medusa exec ./src/scripts/upgrade-china-total-carriers.ts
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
const CARRIER_STD = "中國移動";
const CARRIER_GPT = "中國移動 GPT + TikTok";
const OLD_CARRIER = "CMCC+";

function loadA0(): PlanRow[] {
  const file = join(__dirname, "data", "china-total-a0-plans.json");
  return JSON.parse(readFileSync(file, "utf8")) as PlanRow[];
}

export default async function upgradeChinaTotalCarriers({
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
      "options.values.id",
      "options.values.value",
      "variants.id",
      "variants.sku",
      "variants.title",
      "variants.metadata",
      "variants.options.value",
      "variants.options.option.title",
    ],
    filters: { handle: HANDLE },
  });

  if (!products?.length) {
    throw new Error(`找不到商品 handle=${HANDLE}`);
  }

  const product = products[0] as any;
  const a0Plans = loadA0();
  const existingSkus = new Set(
    (product.variants || []).map((v: any) => v.sku).filter(Boolean),
  );

  const dayValues = new Set<string>();
  const dataValues = new Set<string>();
  for (const v of product.variants || []) {
    for (const opt of v.options || []) {
      const title = opt.option?.title;
      if (title === "使用天數") dayValues.add(opt.value);
      if (title === "數據量") dataValues.add(opt.value);
    }
  }
  for (const p of a0Plans) {
    dayValues.add(`${p.days}天`);
    dataValues.add(`${p.gb}GB`);
  }

  const optionUpdates = (product.options || []).map((opt: any) => {
    if (opt.title === "電信商") {
      return {
        id: opt.id,
        title: opt.title,
        values: [CARRIER_STD, CARRIER_GPT],
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

  const prevMeta =
    product.metadata && typeof product.metadata === "object"
      ? { ...product.metadata }
      : {};

  await updateProductsWorkflow(container).run({
    input: {
      products: [
        {
          id: product.id,
          options: optionUpdates,
          metadata: {
            ...prevMeta,
            hot_sale_telecoms: [CARRIER_GPT],
            carrier_specs_by_carrier: {
              [CARRIER_GPT]: {
                ip_type: "新加坡IP",
                route_type: "漫遊",
                network: "5G/4G",
              },
              [CARRIER_STD]: {
                ip_type: "香港IP",
                route_type: "漫遊",
                network: "5G/4G",
              },
            },
            overview_notices_by_carrier: {
              [CARRIER_GPT]: {
                fup_notice: "用量總計型：流量用完即斷網；支援 GPT／TikTok／Gemini",
                activation_notice: "新加坡 IP・自動設定開通",
              },
              [CARRIER_STD]: {
                fup_notice:
                  "用量總計型：流量用完可能降速；不支援 GPT／TikTok（香港 IP）",
                activation_notice: "香港／新加坡 IP・自動設定開通",
              },
            },
          },
        },
      ],
    },
  });
  logger.info("已更新 options／carrier_specs／hot_sale");

  // 將既有 B0（原 CMCC+）改為「中國移動 GPT + TikTok」
  const renameUpdates: any[] = [];
  for (const v of product.variants || []) {
    const sku = v.sku || "";
    if (!sku.endsWith("-B0") && !sku.includes("CMCC")) {
      // still rename if option is old carrier
    }
    const telecomOpt = (v.options || []).find(
      (o: any) => o.option?.title === "電信商",
    );
    const daysOpt = (v.options || []).find(
      (o: any) => o.option?.title === "使用天數",
    );
    const dataOpt = (v.options || []).find(
      (o: any) => o.option?.title === "數據量",
    );
    const currentTelecom = telecomOpt?.value;
    if (
      currentTelecom === OLD_CARRIER ||
      currentTelecom === "CMCC +" ||
      (sku.endsWith("-B0") && currentTelecom !== CARRIER_GPT)
    ) {
      const days = daysOpt?.value || "";
      const data = dataOpt?.value || "";
      renameUpdates.push({
        id: v.id,
        title: `${CARRIER_GPT} · ${days} · ${data}`,
        options: {
          電信商: CARRIER_GPT,
          使用天數: days,
          數據量: data,
          線路: LINE,
        },
        metadata: {
          ...(v.metadata || {}),
          attributes: {
            ...((v.metadata as any)?.attributes || {}),
            telecom: CARRIER_GPT,
            gpt: true,
            tiktok: true,
            gemini: true,
            ip_type: "新加坡IP",
          },
        },
      });
    }
  }

  if (renameUpdates.length) {
    await updateProductVariantsWorkflow(container).run({
      input: { product_variants: renameUpdates },
    });
    logger.info(`已改名 ${renameUpdates.length} 個 B0 變體 → ${CARRIER_GPT}`);
  }

  const toCreate = a0Plans.filter((p) => !existingSkus.has(p.sku));
  if (toCreate.length) {
    const product_variants = toCreate.map((p) => {
      const days = `${p.days}天`;
      const dataAmount = `${p.gb}GB`;
      return {
        product_id: product.id,
        title: `${CARRIER_STD} · ${days} · ${dataAmount}`,
        sku: p.sku,
        manage_inventory: false,
        options: {
          使用天數: days,
          數據量: dataAmount,
          電信商: CARRIER_STD,
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
            telecom: CARRIER_STD,
            line: LINE,
            network: "5G/4G",
            ip_type: "香港IP",
            hotspot: true,
            gpt: false,
            tiktok: false,
            gemini: true,
            plan_type: "total",
            speed_rule: "降速或用完斷網",
          },
        },
      };
    });

    const { result } = await createProductVariantsWorkflow(container).run({
      input: { product_variants },
    });
    logger.info(`已新增 ${result.length} 個 A0 變體（${CARRIER_STD}）`);
  } else {
    logger.info("A0 變體皆已存在，略過新增");
  }

  logger.info("完成：電信商 = 中國移動 / 中國移動 GPT + TikTok");
}
