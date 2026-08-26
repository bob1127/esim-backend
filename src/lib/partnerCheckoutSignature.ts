// 夥伴結帳定價簽章「後端驗證端」。演算法必須與前台
// esim-store-front/lib/partnerCheckoutSignature.js 完全一致。
//
// 夥伴售價由可信的 Next.js 伺服器端計算並簽章；此處僅負責「驗簽 + 檢查時效」，
// 通過後才把單價覆寫到 Medusa 購物車。密鑰只存在伺服器環境變數。
import crypto from "crypto";

export const PARTNER_CHECKOUT_SIG_TTL_MS = 5 * 60 * 1000;

export type PartnerPricingLine = { item_id: string; unit_price: number };

export type PartnerPricingPayload = {
  cartId: string;
  storeId: string | number;
  partnerId: string | number | null;
  lines: PartnerPricingLine[];
  total: number;
  b2bCost: number;
  partnerProfit: number;
  ts: number;
};

export function getPartnerCheckoutSecret(): string {
  return process.env.PARTNER_CHECKOUT_SECRET || "";
}

export function buildPartnerPricingCanonical(
  payload: PartnerPricingPayload,
): string {
  const lines = [...(payload.lines || [])]
    .map((l) => ({
      item_id: String(l.item_id),
      unit_price: Math.round(Number(l.unit_price) || 0),
    }))
    .sort((a, b) =>
      a.item_id < b.item_id ? -1 : a.item_id > b.item_id ? 1 : 0,
    );

  const linesStr = lines.map((l) => `${l.item_id}:${l.unit_price}`).join(",");

  return [
    "v1",
    String(payload.cartId || ""),
    String(payload.storeId ?? ""),
    String(payload.partnerId ?? ""),
    Math.round(Number(payload.total) || 0),
    Math.round(Number(payload.b2bCost) || 0),
    Math.round(Number(payload.partnerProfit) || 0),
    Math.round(Number(payload.ts) || 0),
    linesStr,
  ].join("|");
}

/** 定時安全比較，避免時間側通道 */
function safeEqualHex(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, "hex");
    const bb = Buffer.from(b, "hex");
    if (ba.length !== bb.length || ba.length === 0) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

/**
 * 驗簽 + 時效。回傳 { ok, reason }。
 */
export function verifyPartnerPricing(
  payload: PartnerPricingPayload,
  signature: string,
  secret = getPartnerCheckoutSecret(),
): { ok: boolean; reason?: string } {
  if (!secret) return { ok: false, reason: "SECRET_NOT_SET" };
  if (!signature) return { ok: false, reason: "NO_SIGNATURE" };

  const ts = Math.round(Number(payload?.ts) || 0);
  if (!ts) return { ok: false, reason: "NO_TS" };
  const age = Date.now() - ts;
  if (age < -60 * 1000 || age > PARTNER_CHECKOUT_SIG_TTL_MS) {
    return { ok: false, reason: "EXPIRED" };
  }

  const canonical = buildPartnerPricingCanonical(payload);
  const expected = crypto
    .createHmac("sha256", secret)
    .update(canonical)
    .digest("hex");

  if (!safeEqualHex(expected, String(signature))) {
    return { ok: false, reason: "BAD_SIGNATURE" };
  }
  return { ok: true };
}
