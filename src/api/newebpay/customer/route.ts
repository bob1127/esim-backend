import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { verifyAndDecryptTradeInfo } from "../../../lib/newebpay/crypto";

function resolveStoreUrl(): string {
  return (process.env.STORE_URL || "https://www.jeko-esim.com.tw").replace(
    /\/$/,
    "",
  );
}

/**
 * 藍新 ATM/超商取號導回（CustomerURL）。純顯示用：只負責把使用者導回
 * 前台 /pending 頁面，實際取號資料的寫入由 /newebpay/notify 負責。
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const storeUrl = resolveStoreUrl();

  try {
    const body = (req.body || {}) as Record<string, any>;
    const tiRaw = String(body.TradeInfo || "");
    const tsRaw = String(body.TradeSha || "");
    const hashKey = process.env.NEWEBPAY_HASH_KEY || "";
    const hashIv = process.env.NEWEBPAY_HASH_IV || "";

    let orderNo =
      (Array.isArray(req.query?.orderNo)
        ? (req.query!.orderNo as any)[0]
        : (req.query?.orderNo as string | undefined)) || "";

    const outcome = verifyAndDecryptTradeInfo(tiRaw, tsRaw, hashKey, hashIv);
    const merchantOrderNo = outcome.result?.MerchantOrderNo;
    if (merchantOrderNo) orderNo = String(merchantOrderNo);

    if (!orderNo) {
      return res.redirect(302, `${storeUrl}/pending`);
    }

    return res.redirect(
      302,
      `${storeUrl}/pending?orderNo=${encodeURIComponent(orderNo)}`,
    );
  } catch (error: any) {
    console.error("[newebpay-customer] 例外:", error?.message || error);
    return res.redirect(302, `${storeUrl}/pending`);
  }
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const orderNo =
    (Array.isArray(req.query?.orderNo)
      ? (req.query!.orderNo as any)[0]
      : (req.query?.orderNo as string | undefined)) || "";
  const storeUrl = resolveStoreUrl();
  return res.redirect(
    302,
    orderNo
      ? `${storeUrl}/pending?orderNo=${encodeURIComponent(orderNo)}`
      : `${storeUrl}/pending`,
  );
}
