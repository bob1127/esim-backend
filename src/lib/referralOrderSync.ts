// 優惠連結（referral）夥伴訂單 → Supabase 同步。
//
// 藍新 notify / LINE Pay confirm 確認付款成功後呼叫。優惠連結訂單走的是「與主站
// 同一套結帳」（Medusa 訂單 + 官網售價 + 夥伴專屬折扣碼），Medusa 這邊只留一個
// metadata.jeko_referral_code，因此分潤必須在這裡用伺服器端資料重算，再以 orders
// 列寫回 Supabase，夥伴後台的訂單／分潤／結算／出金才有資料來源。
//
// 安全原則（勿改）：
//   - 趴數只信 Supabase：商品 metadata 的電信商分潤％ → partners.referral_rate
//   - 成本只信 Medusa 變體 metadata.cost_price／b2b_price
//   - 售價用付款流程核對過的金額，不採信前端任何欄位
//   - 分潤上限為該筆訂單毛利（售價 − 成本），不可為負
//
// 冪等：以 medusa_order_id（唯一索引）upsert，藍新／LINE 重試不會重複建立；
// 已退款／已取消的列不再被付款重試覆寫回 completed。
import { getSupabaseAdmin } from "./supabaseAdmin";
import { resolveUnitCostFromItem } from "./orderProfit";

/** 專屬連結預設分潤：成本 × 25%（需與前台 lib/partnerReferral.js 一致） */
export const DEFAULT_REFERRAL_RATE = 25;

/** 商品 metadata：各電信商「優惠連結夥伴」分潤％ */
const PARTNER_RATE_METADATA_KEY = "carrier_partner_rate_by_carrier";

/** 已進入退款／取消流程的列，不因付款重試被改回 completed */
const LOCKED_STATUSES = new Set([
  "refunded",
  "refund_pending",
  "cancelled",
  "canceled",
]);

type OrderItemLike = {
  title?: string;
  product_title?: string;
  product_id?: string | null;
  variant_sku?: string;
  variant_title?: string;
  quantity?: number;
  unit_price?: number;
  subtotal?: number;
  /** 折扣後行金額（優惠連結有 9 折促銷，明細要用折後價才會等於實付總額） */
  total?: number;
  metadata?: Record<string, any> | null;
  variant?: {
    id?: string;
    sku?: string;
    metadata?: Record<string, any> | null;
    options?: any;
  } | null;
};

type MedusaOrderLike = {
  id: string;
  display_id?: number | string | null;
  email?: string | null;
  metadata?: Record<string, any> | null;
  items?: OrderItemLike[];
};

type QueryLike = {
  graph: (args: Record<string, unknown>) => Promise<{ data: any[] }>;
};

export type ReferralSyncResult = {
  ok: boolean;
  skipped?: string;
  partnerId?: number;
  referralCode?: string;
  ratePercent?: number;
  b2bCost?: number;
  partnerProfit?: number;
};

/** 與前台 normalizeReferralCode 同演算法 */
function normalizeReferralCode(raw: unknown): string {
  if (!raw || typeof raw !== "string") return "";
  return raw.trim().toLowerCase().replace(/[^a-z0-9-_]/g, "");
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** 與前台 productPartnerTerms.parsePercentMap 同行為 */
function parsePercentMap(raw: unknown): Record<string, number> {
  if (!raw) return {};
  let parsed: any = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

  const out: Record<string, number> = {};
  for (const [carrier, value] of Object.entries(parsed)) {
    const n = Number(String(value).replace("%", "").trim());
    if (Number.isFinite(n) && n > 0) out[String(carrier).trim()] = n;
  }
  return out;
}

function findCarrierEntry(
  map: Record<string, number>,
  carrierName: string,
): number | null {
  const carrier = String(carrierName || "").trim();
  if (!carrier) return null;
  if (map[carrier] != null) return map[carrier];
  const key = Object.keys(map).find(
    (k) => k.trim().toLowerCase() === carrier.toLowerCase(),
  );
  return key != null ? map[key] : null;
}

/** 從變體 metadata／options 取電信商名稱（與前台 resolveTelecomFromVariant 對齊） */
function resolveCarrierFromItem(item: OrderItemLike): string {
  const vMeta: Record<string, any> = item?.variant?.metadata || {};
  const fromMeta = vMeta.carrier || vMeta.attributes?.telecom || "";
  if (fromMeta) return String(fromMeta).trim();

  const opts = item?.variant?.options;
  if (Array.isArray(opts)) {
    for (const o of opts) {
      const title = String(
        o?.option?.title || o?.title || o?.option_id || "",
      ).toLowerCase();
      if (
        title.includes("電信") ||
        title.includes("telecom") ||
        title.includes("carrier")
      ) {
        return String(o?.value || o?.option_value || "").trim();
      }
    }
  } else if (opts && typeof opts === "object") {
    for (const [k, v] of Object.entries(opts)) {
      if (/電信|telecom|carrier/i.test(k)) return String(v || "").trim();
    }
  }
  return "";
}

/**
 * 分潤 = 成本 × 趴數，但不得超過該筆訂單毛利（售價 − 成本），也不得為負。
 * 與前台 lib/partnerReferral.js computeReferralProfit 同語意。
 */
export function capReferralProfit(
  rawProfit: number,
  totalCost: number,
  sellPrice: number,
): number {
  const gross = Math.max(0, Math.round(sellPrice) - Math.round(totalCost));
  return Math.min(Math.max(0, Math.round(rawProfit)), gross);
}

/** 一次撈齊本單商品的電信商分潤％設定（Boss 在商品頁設定的 per-carrier 趴數） */
async function loadProductRateMaps(
  query: QueryLike | null | undefined,
  productIds: string[],
): Promise<Record<string, Record<string, number>>> {
  if (!query || !productIds.length) return {};
  try {
    const { data: products } = await query.graph({
      entity: "product",
      fields: ["id", "metadata"],
      filters: { id: productIds },
    });
    const out: Record<string, Record<string, number>> = {};
    for (const p of products || []) {
      const map = parsePercentMap(p?.metadata?.[PARTNER_RATE_METADATA_KEY]);
      if (Object.keys(map).length) out[String(p.id)] = map;
    }
    return out;
  } catch (err: any) {
    console.warn(
      "[referralOrderSync] 讀取商品分潤％設定失敗，改用夥伴預設趴數:",
      err?.message || err,
    );
    return {};
  }
}

/**
 * 逐項算成本與分潤：每項各自套用（電信商趴數 → 夥伴預設趴數），最後才用
 * 整單毛利做上限。這樣 Boss 針對個別電信商設定的趴數才會真的生效。
 */
function priceReferralLines(
  items: OrderItemLike[],
  rateMapsByProduct: Record<string, Record<string, number>>,
  partnerRate: number,
) {
  let totalCost = 0;
  let rawProfit = 0;
  const rateSamples: number[] = [];

  const itemDetails = (items || []).map((it) => {
    const qty = Math.max(1, Math.round(num(it.quantity) || 1));
    const unitCost = resolveUnitCostFromItem(it);
    const unitPrice =
      typeof it.total === "number" && it.total > 0
        ? Math.round(num(it.total) / qty)
        : typeof it.unit_price === "number"
          ? Math.round(it.unit_price)
          : typeof it.subtotal === "number"
            ? Math.round(num(it.subtotal) / qty)
            : 0;

    const rateMap: Record<string, number> = it.product_id
      ? rateMapsByProduct[String(it.product_id)] || {}
      : {};
    let rate: number | null = findCarrierEntry(
      rateMap,
      resolveCarrierFromItem(it),
    );
    if (rate == null) {
      // 對不到電信商時：該商品只設一個趴數就用它（比照前台 resolveCartPartnerTerms）
      const vals = Object.values(rateMap);
      if (vals.length === 1) rate = vals[0];
    }
    const effectiveRate =
      rate != null && rate > 0 && rate <= 100 ? rate : partnerRate;

    const lineCost = unitCost * qty;
    totalCost += lineCost;
    rawProfit += Math.round((lineCost * effectiveRate) / 100);
    rateSamples.push(effectiveRate);

    return {
      name: it.product_title || it.title || "",
      sku: it.variant_sku || it.variant?.sku || it.metadata?.esim_plan_id || "",
      quantity: qty,
      price: unitPrice,
      partner_rate_percent: effectiveRate,
    };
  });

  const ratePercent = rateSamples.length
    ? Math.round(rateSamples.reduce((a, b) => a + b, 0) / rateSamples.length)
    : partnerRate;

  return {
    itemDetails,
    totalCost: Math.round(totalCost),
    rawProfit: Math.round(rawProfit),
    ratePercent,
  };
}

/**
 * 付款成功 → 以 orders 列把優惠連結訂單寫回 Supabase。
 * 回傳算好的分潤數字，呼叫端可寫進 Medusa order.metadata 供 Boss 對帳。
 */
export async function upsertReferralOrderToSupabase(params: {
  order: MedusaOrderLike;
  merchantOrderNo: string;
  totalAmount: number;
  payType?: string;
  paymentProvider?: "newebpay" | "linepay";
  query?: QueryLike | null;
}): Promise<ReferralSyncResult> {
  const {
    order,
    merchantOrderNo,
    totalAmount,
    payType,
    paymentProvider = "newebpay",
    query,
  } = params;

  const meta = order.metadata || {};
  const referralCode = normalizeReferralCode(meta.jeko_referral_code);
  if (!referralCode) return { ok: false, skipped: "no_referral_code" };

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    console.warn(
      "[referralOrderSync] 未設定 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY，略過同步",
    );
    return { ok: false, skipped: "no_supabase_env" };
  }

  const { data: partner, error: partnerErr } = await supabase
    .from("partners")
    .select(
      "id, status, cooperation_model, referral_rate, referral_discount_enabled, referral_discount_percent, referral_code",
    )
    .eq("referral_code", referralCode)
    .eq("cooperation_model", "referral")
    .maybeSingle();

  if (partnerErr) throw new Error(partnerErr.message);
  if (!partner) {
    console.warn(
      `[referralOrderSync] 找不到優惠連結夥伴（code=${referralCode}），略過分潤`,
    );
    return { ok: false, skipped: "partner_not_found", referralCode };
  }
  if (String(partner.status || "").toLowerCase() !== "active") {
    console.warn(
      `[referralOrderSync] 夥伴 ${partner.id} 非 active（${partner.status}），略過分潤`,
    );
    return { ok: false, skipped: "partner_inactive", referralCode };
  }

  const partnerRateRaw = Number(partner.referral_rate);
  const partnerRate =
    Number.isFinite(partnerRateRaw) && partnerRateRaw > 0 && partnerRateRaw <= 100
      ? partnerRateRaw
      : DEFAULT_REFERRAL_RATE;

  const items = Array.isArray(order.items) ? order.items : [];
  const productIds = [
    ...new Set(items.map((it) => it.product_id).filter(Boolean) as string[]),
  ];
  const rateMapsByProduct = await loadProductRateMaps(query, productIds);

  const total = Math.round(num(totalAmount));
  const { itemDetails, totalCost, rawProfit, ratePercent } = priceReferralLines(
    items,
    rateMapsByProduct,
    partnerRate,
  );
  const partnerProfit = capReferralProfit(rawProfit, totalCost, total);

  const discountEnabled = partner.referral_discount_enabled !== false;
  const discountPercentRaw = Number(partner.referral_discount_percent);
  const referralDiscountPercent = discountEnabled
    ? Number.isFinite(discountPercentRaw) && discountPercentRaw > 0
      ? Math.round(discountPercentRaw)
      : 10
    : null;

  if (totalCost <= 0) {
    console.warn(
      `[referralOrderSync] 訂單 ${order.id} 取不到商品成本（變體缺 cost_price），分潤以 0 計，請補設定後手動校正`,
    );
  }

  const { data: existing } = await supabase
    .from("orders")
    .select("id, status")
    .eq("medusa_order_id", order.id)
    .maybeSingle();

  if (existing?.id && LOCKED_STATUSES.has(String(existing.status || ""))) {
    console.log(
      `[referralOrderSync] 訂單 ${order.id} 已是 ${existing.status}，不覆寫分潤`,
    );
    return {
      ok: true,
      skipped: "locked_status",
      partnerId: Number(partner.id),
      referralCode,
      ratePercent,
      b2bCost: totalCost,
      partnerProfit,
    };
  }

  const row: Record<string, unknown> = {
    medusa_order_id: order.id,
    store_id: null,
    partner_id: Number(partner.id),
    channel: "referral",
    referral_code: referralCode,
    customer_email: order.email
      ? String(order.email).trim().toLowerCase()
      : null,
    total_amount: total,
    total_price: total,
    b2b_cost: totalCost,
    partner_profit: partnerProfit,
    status: "completed",
    item_details: itemDetails,
    payment_info: {
      provider: paymentProvider,
      merchant_order_no: merchantOrderNo,
      payment_type: payType || "",
      referral_code: referralCode,
      partner_rate_percent: ratePercent,
      referral_discount_percent: referralDiscountPercent,
      referral_discount_applied: referralDiscountPercent != null,
      coupon: referralDiscountPercent != null ? referralCode.toUpperCase() : null,
      ...(order.display_id != null && order.display_id !== ""
        ? { display_id: Number(order.display_id) || order.display_id }
        : {}),
    },
    updated_at: new Date().toISOString(),
  };

  // migration 20260828 未跑時（缺 channel／referral_code 欄位）降級寫入，
  // 至少讓分潤與結算資料先進得去。
  const writeRow = async (payload: Record<string, unknown>) => {
    if (existing?.id) {
      return supabase.from("orders").update(payload).eq("id", existing.id);
    }
    return supabase.from("orders").insert(payload);
  };

  let { error } = await writeRow(row);

  if (error && /channel|referral_code|column/i.test(error.message || "")) {
    console.warn(
      "[referralOrderSync] orders 缺 channel／referral_code 欄位（請執行 migration 20260828_orders_referral_channel.sql），本次降級寫入",
    );
    const { channel: _c, referral_code: _r, ...slim } = row as any;
    ({ error } = await writeRow(slim));
  }

  if (error) {
    // 併發下另一個 notify 可能已插入 → 唯一鍵衝突視為成功
    if (/duplicate key|unique/i.test(error.message || "")) {
      return {
        ok: true,
        skipped: "duplicate",
        partnerId: Number(partner.id),
        referralCode,
        ratePercent,
        b2bCost: totalCost,
        partnerProfit,
      };
    }
    throw new Error(error.message);
  }

  return {
    ok: true,
    partnerId: Number(partner.id),
    referralCode,
    ratePercent,
    b2bCost: totalCost,
    partnerProfit,
  };
}

/** 供 notify／confirm 寫回 Medusa order.metadata 的欄位（Boss 對帳用） */
export function buildReferralOrderMetadata(
  result: ReferralSyncResult,
): Record<string, unknown> {
  if (!result?.ok || result.partnerId == null) return {};
  return {
    // 刻意不用 partner_id：那個鍵會讓主站報表把此單當夥伴店訂單排除掉
    referral_partner_id: String(result.partnerId),
    referral_rate_percent: result.ratePercent ?? "",
    referral_b2b_cost: result.b2bCost ?? 0,
    referral_partner_profit: result.partnerProfit ?? 0,
    referral_synced_at: new Date().toISOString(),
  };
}
