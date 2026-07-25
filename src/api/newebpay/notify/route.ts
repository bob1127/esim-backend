import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import {
  verifyAndDecryptTradeInfo,
  isPaidResult,
  isOffsitePendingResult,
  buildOffsiteInfo,
  firstPayMoment,
} from "../../../lib/newebpay/crypto";

/**
 * 藍新 MPG 背景通知（NotifyURL）。這是唯一權威的付款狀態來源：
 * ReturnURL / CustomerURL 只負責把使用者導回前台顯示狀態，不會在這裡寫任何資料。
 *
 * 不放在 /store 或 /admin 底下，直接用 req.scope 解析 order / payment module，
 * 不需要任何對外憑證（比照凱仕 TapPay 的 /tappay/notify 作法）。
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const rid = Math.random().toString(36).slice(2, 10);

  try {
    const body = (req.body || {}) as Record<string, any>;
    const tiRaw = String(body.TradeInfo || "");
    const tsRaw = String(body.TradeSha || "");
    const hashKey = process.env.NEWEBPAY_HASH_KEY || "";
    const hashIv = process.env.NEWEBPAY_HASH_IV || "";

    const outcome = verifyAndDecryptTradeInfo(tiRaw, tsRaw, hashKey, hashIv);
    if (!outcome.shaOk || !outcome.result) {
      console.warn(
        `[newebpay-notify:${rid}] 驗簽/解密失敗: ${outcome.error || "unknown"}`,
      );
      // 回 200 避免藍新重試風暴
      return res.status(200).send("OK");
    }

    const result = outcome.result;
    const merchantOrderNo = String(result?.MerchantOrderNo || "");
    if (!merchantOrderNo) {
      console.warn(`[newebpay-notify:${rid}] 缺少 MerchantOrderNo`);
      return res.status(200).send("OK");
    }

    const orderId = `order_${merchantOrderNo}`;
    const query = req.scope.resolve("query") as any;
    const { data: orders } = await query.graph({
      entity: "order",
      fields: [
        "id",
        "email",
        "total",
        "payment_status",
        "metadata",
        "items.title",
        "items.product_title",
        "items.variant_sku",
        "items.quantity",
        "items.metadata",
        "payment_collections.payment_sessions.id",
      ],
      filters: { id: [orderId] },
    });

    const order = orders?.[0];
    if (!order) {
      console.warn(
        `[newebpay-notify:${rid}] 找不到訂單: MerchantOrderNo=${merchantOrderNo}`,
      );
      return res.status(200).send("OK");
    }

    const payType = String(result?.PaymentType || "").toUpperCase();
    const orderModule = req.scope.resolve("order") as any;

    /* A) 取號成功（ATM/超商/WebATM）但尚未入帳 → 只寫 metadata，不 capture */
    if (isOffsitePendingResult(result)) {
      const offsite = buildOffsiteInfo(result);
      await orderModule.updateOrders([
        {
          id: order.id,
          metadata: {
            ...(order.metadata || {}),
            newebpay_merchant_order_no: merchantOrderNo,
            newebpay_payment_type: payType,
            newebpay_offsite_info: JSON.stringify(offsite),
          },
        },
      ]);
      console.log(`[newebpay-notify:${rid}] offsite pending: ${order.id}`);
      return res.status(200).send("OK");
    }

    /* B) 未達已付款條件（例如信用卡失敗）→ 不處理 */
    if (!isPaidResult(result, outcome.payloadStatus)) {
      console.log(
        `[newebpay-notify:${rid}] noop: Status=${outcome.payloadStatus} PaymentType=${payType}`,
      );
      return res.status(200).send("OK");
    }

    /* C) 已付款 → authorize + capture（冪等）→ 觸發 eSIM 發貨 */
    const alreadyPaid = !!order.metadata?.newebpay_pay_time;

    if (!alreadyPaid && order.payment_status !== "captured") {
      const sessionId =
        order.payment_collections?.[0]?.payment_sessions?.[0]?.id;
      if (sessionId) {
        try {
          const paymentModule = req.scope.resolve("payment") as any;
          const payment = await paymentModule.authorizePaymentSession(
            sessionId,
            {},
          );
          if (payment?.id) {
            await paymentModule.capturePayment({
              payment_id: payment.id,
              amount: order.total,
            });
            console.log(`[newebpay-notify:${rid}] 已 capture: ${order.id}`);
          }
        } catch (payErr: any) {
          console.error(
            `[newebpay-notify:${rid}] authorize/capture 失敗:`,
            payErr?.message || payErr,
          );
        }
      } else {
        console.warn(
          `[newebpay-notify:${rid}] 找不到 payment session: ${order.id}`,
        );
      }
    }

    await orderModule.updateOrders([
      {
        id: order.id,
        metadata: {
          ...(order.metadata || {}),
          newebpay_merchant_order_no: merchantOrderNo,
          newebpay_payment_type: payType,
          newebpay_trade_no: String(result?.TradeNo || ""),
          newebpay_pay_time: String(firstPayMoment(result)),
        },
      },
    ]);

    const hasQrcodes = !!order.metadata?.esim_qrcodes;
    const fulfillBase = process.env.FULFILLMENT_INTERNAL_URL;

    if (!hasQrcodes && fulfillBase) {
      try {
        const fulfillRes = await fetch(
          `${fulfillBase.replace(/\/$/, "")}/api/internal/fulfill-order`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Fulfillment-Secret":
                process.env.FULFILLMENT_INTERNAL_SECRET || "",
            },
            body: JSON.stringify({
              orderId: order.id,
              email: order.email,
              items: (order.items || []).map((it: any) => ({
                name: it.product_title || it.title,
                sku: it.variant_sku || it.metadata?.esim_plan_id || "",
                quantity: it.quantity,
              })),
            }),
          },
        );
        const fulfillData = await fulfillRes.json().catch(() => ({}));

        if (
          fulfillRes.ok &&
          Array.isArray(fulfillData?.qrcodes) &&
          fulfillData.qrcodes.length
        ) {
          await orderModule.updateOrders([
            {
              id: order.id,
              metadata: {
                ...(order.metadata || {}),
                esim_qrcodes: JSON.stringify(fulfillData.qrcodes),
              },
            },
          ]);
          console.log(`[newebpay-notify:${rid}] 發貨完成: ${order.id}`);
        } else {
          console.error(
            `[newebpay-notify:${rid}] 發貨失敗:`,
            fulfillData?.message || fulfillData,
          );
        }
      } catch (fulfillErr: any) {
        console.error(
          `[newebpay-notify:${rid}] 呼叫發貨 API 例外:`,
          fulfillErr?.message || fulfillErr,
        );
      }
    } else if (hasQrcodes) {
      console.log(`[newebpay-notify:${rid}] eSIM 已發過，略過: ${order.id}`);
    } else {
      console.warn(`[newebpay-notify:${rid}] 未設定 FULFILLMENT_INTERNAL_URL`);
    }

    return res.status(200).send("OK");
  } catch (error: any) {
    console.error(`[newebpay-notify:${rid}] 例外:`, error?.message || error);
    return res.status(200).send("OK");
  }
}
