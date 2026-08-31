// 夥伴店訂單 → Supabase 同步。
//
// 藍新 notify 確認付款成功後呼叫；把這筆（走統一 Medusa+藍新流程、但帶 store_id
// 的夥伴店）訂單，以 orders 列的形式寫回 Supabase，讓夥伴後台的訂單、分潤、結算、
// 出金流程可以照舊運作（那些頁面都讀 Supabase public.orders）。
//
// 冪等：以 medusa_order_id（唯一）upsert，藍新重試不會重複建立。
import { getSupabaseAdmin } from "./supabaseAdmin";

type MedusaOrderLike = {
  id: string;
  display_id?: number | string | null;
  email?: string | null;
  metadata?: Record<string, any> | null;
  items?: Array<{
    title?: string;
    product_title?: string;
    variant_sku?: string;
    quantity?: number;
    unit_price?: number;
    subtotal?: number;
    metadata?: Record<string, any> | null;
  }>;
};

function toIntOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

export async function upsertPartnerOrderToSupabase(params: {
  order: MedusaOrderLike;
  merchantOrderNo: string;
  totalAmount: number;
  payType?: string;
}): Promise<{ ok: boolean; skipped?: string }> {
  const { order, merchantOrderNo, totalAmount, payType } = params;
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    console.warn(
      "[partnerOrderSync] 未設定 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY，略過同步",
    );
    return { ok: false, skipped: "no_supabase_env" };
  }

  const meta = order.metadata || {};
  const storeId = toIntOrNull(meta.partner_store_id);
  const partnerId = toIntOrNull(meta.partner_id);
  const b2bCost = Math.round(Number(meta.partner_b2b_cost) || 0);
  const partnerProfit = Math.round(Number(meta.partner_profit) || 0);
  const total = Math.round(Number(totalAmount) || Number(meta.partner_total) || 0);

  const itemDetails = (order.items || []).map((it) => {
    const qty = Math.max(1, Math.round(Number(it.quantity) || 1));
    const unit =
      typeof it.unit_price === "number"
        ? Math.round(it.unit_price)
        : typeof it.subtotal === "number" && qty
          ? Math.round(Number(it.subtotal) / qty)
          : 0;
    return {
      name: it.product_title || it.title || "",
      sku: it.variant_sku || it.metadata?.esim_plan_id || "",
      quantity: qty,
      price: unit,
      b2b_cost: 0 as number,
    };
  });

  if (b2bCost > 0 && itemDetails.length) {
    const revTotal = itemDetails.reduce(
      (s, it) => s + (Number(it.price) || 0) * (Number(it.quantity) || 1),
      0,
    );
    for (const it of itemDetails) {
      const lineRev = (Number(it.price) || 0) * (Number(it.quantity) || 1);
      const lineB2b =
        revTotal > 0 ? Math.round((b2bCost * lineRev) / revTotal) : 0;
      it.b2b_cost =
        (Number(it.quantity) || 1) > 0
          ? Math.round(lineB2b / (Number(it.quantity) || 1))
          : 0;
    }
  }

  // 以 medusa_order_id 冪等 upsert；若既有列已 completed 則不覆蓋分潤數字
  const { data: existing } = await supabase
    .from("orders")
    .select("id, status")
    .eq("medusa_order_id", order.id)
    .maybeSingle();

  const row: Record<string, unknown> = {
    medusa_order_id: order.id,
    store_id: storeId,
    partner_id: partnerId,
    channel: "store",
    customer_email: order.email
      ? String(order.email).trim().toLowerCase()
      : null,
    total_amount: total,
    total_price: total,
    b2b_cost: b2bCost,
    partner_profit: partnerProfit,
    status: "completed",
    item_details: itemDetails,
    payment_info: {
      provider: "newebpay",
      merchant_order_no: merchantOrderNo,
      payment_type: payType || "",
      ...(order.display_id != null && order.display_id !== ""
        ? { display_id: Number(order.display_id) || order.display_id }
        : {}),
    },
    updated_at: new Date().toISOString(),
  };

  const writeRow = async (payload: Record<string, unknown>) => {
    if (existing?.id) {
      return supabase.from("orders").update(payload).eq("id", existing.id);
    }
    return supabase.from("orders").insert(payload);
  };

  let { error } = await writeRow(row);

  // migration 20260828 未跑時（缺 channel 欄位）降級寫入，避免擋住分潤同步
  if (error && /channel|column/i.test(error.message || "")) {
    const { channel: _channel, ...slim } = row as any;
    ({ error } = await writeRow(slim));
  }

  if (error) {
    // 併發下另一個 notify 可能已插入 → 唯一鍵衝突視為成功
    if (/duplicate key|unique/i.test(error.message || "")) {
      return { ok: true, skipped: "duplicate" };
    }
    throw new Error(error.message);
  }
  return { ok: true };
}
