import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import {
  verifyAndDecryptTradeInfo,
  isPaidResult,
  isOffsitePendingResult,
  firstPayMoment,
} from "../../../lib/newebpay/crypto";

function resolveStoreUrl(): string {
  return (process.env.STORE_URL || "https://www.jeko-esim.com.tw").replace(
    /\/$/,
    "",
  );
}

/**
 * 藍新信用卡 3D 導回（ReturnURL）。純顯示用：只決定導向狀態，
 * **不**寫任何資料，避免和權威來源 /newebpay/notify 重複處理。
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const storeUrl = resolveStoreUrl();

  try {
    const body = (req.body || {}) as Record<string, any>;
    const tiRaw = String(body.TradeInfo || "");
    const tsRaw = String(body.TradeSha || "");
    const hashKey = process.env.NEWEBPAY_HASH_KEY || "";
    const hashIv = process.env.NEWEBPAY_HASH_IV || "";

    const outcome = verifyAndDecryptTradeInfo(tiRaw, tsRaw, hashKey, hashIv);
    const result = outcome.result;
    const orderNo = String(result?.MerchantOrderNo || body?.MerchantOrderNo || "");

    if (!orderNo) {
      return res.redirect(302, `${storeUrl}/thank-you?status=error`);
    }

    let status = "fail";
    if (isPaidResult(result, outcome.payloadStatus)) status = "success";
    else if (isOffsitePendingResult(result)) status = "pending";

    const qsExtra = new URLSearchParams({
      orderNo,
      status,
      paymentType: String(result?.PaymentType || ""),
      payTime: firstPayMoment(result),
      tradeNo: String(result?.TradeNo || ""),
    }).toString();

    return res.redirect(302, `${storeUrl}/thank-you?${qsExtra}`);
  } catch (error: any) {
    console.error("[newebpay-return] 例外:", error?.message || error);
    return res.redirect(302, `${storeUrl}/thank-you?status=error`);
  }
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  return res.redirect(302, `${resolveStoreUrl()}/thank-you?status=error`);
}
