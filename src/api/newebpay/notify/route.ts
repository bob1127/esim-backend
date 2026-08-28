import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import {
  verifyAndDecryptTradeInfo,
  isPaidResult,
  isOffsitePendingResult,
  buildOffsiteInfo,
  firstPayMoment,
} from "../../../lib/newebpay/crypto";
import {
  resolveTwdAmount,
  sumLineItemsAmount,
  loadOrderPayableAmount,
  verifyPaymentAmount,
} from "../../../lib/orderAmount";
import { upsertPartnerOrderToSupabase } from "../../../lib/partnerOrderSync";
import { appendAccountingSheet, buildAccountingPayload } from "../../../lib/appendAccountingSheet";
import { notifyAdminNewOrder } from "../../../lib/appendAdminOrderNotify";

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
        "items.unit_price",
        "items.subtotal",
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

    /* C) 已付款 → 先核對金額，再 authorize + capture（冪等）→ 觸發 eSIM 發貨 */

    // 金額核對：藍新回報的 Amt（已驗簽）必須等於 DB 重新計算的訂單金額，
    // 以及建單時記錄的 newebpay_amount。任何不符即中止，不 capture、不發貨。
    const expected =
      resolveTwdAmount(order.total, sumLineItemsAmount(order.items)) ||
      (await loadOrderPayableAmount(req.scope, order.id, 0));
    const reserved = resolveTwdAmount(order.metadata?.newebpay_amount);
    const paid = resolveTwdAmount(result?.Amt);
    const amountError = verifyPaymentAmount({ expected, reserved, paid });
    if (amountError) {
      console.error(
        `[newebpay-notify:${rid}] 金額核對失敗（訂單 ${order.id}）: ${amountError}`,
      );
      await orderModule.updateOrders([
        {
          id: order.id,
          metadata: {
            ...(order.metadata || {}),
            newebpay_amount_mismatch: `${amountError} @ ${new Date().toISOString()}`,
          },
        },
      ]);
      // 回 200 避免藍新重試風暴；此訂單需人工對帳處理
      return res.status(200).send("OK");
    }

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
              amount: expected,
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

    if (!alreadyPaid) {
      const accountingPayload = buildAccountingPayload(order, {
        amount: expected,
        paymentProvider: "newebpay",
        payTime: String(firstPayMoment(result)),
        tradeNo: String(result?.TradeNo || merchantOrderNo),
      });
      void appendAccountingSheet(accountingPayload);
      void notifyAdminNewOrder(accountingPayload);
    }

    /* C-1) 夥伴店訂單 → 付款成功後把分潤列寫回 Supabase（供夥伴後台結算／出金）。
       金額一律用 DB 重算後的 expected（＝夥伴售價），分潤歸屬用 order.metadata
       內「已由簽章驗證過」的值；以 medusa_order_id 冪等 upsert，重試不重複。 */
    if (order.metadata?.is_partner_order) {
      try {
        await upsertPartnerOrderToSupabase({
          order,
          merchantOrderNo,
          totalAmount: expected,
          payType,
        });
      } catch (syncErr: any) {
        console.error(
          `[newebpay-notify:${rid}] 夥伴訂單同步 Supabase 失敗:`,
          syncErr?.message || syncErr,
        );
      }
    }

    const hasQrcodes = !!order.metadata?.esim_qrcodes;
    const hasInvoice = !!order.metadata?.ezpay_invoice_number;
    const fulfillBase = process.env.FULFILLMENT_INTERNAL_URL;
    const internalHeaders = {
      "Content-Type": "application/json",
      "X-Fulfillment-Secret": process.env.FULFILLMENT_INTERNAL_SECRET || "",
    };
    const lineItems = (order.items || []).map((it: any) => ({
      name: it.product_title || it.title,
      sku: it.variant_sku || it.metadata?.esim_plan_id || "",
      quantity: it.quantity,
      // Medusa major units（twd）
      unit_price:
        typeof it.unit_price === "number"
          ? it.unit_price
          : typeof it.subtotal === "number" && it.quantity
            ? Math.round(Number(it.subtotal) / Number(it.quantity))
            : undefined,
    }));

    if (!hasQrcodes && fulfillBase) {
      try {
        const fulfillRes = await fetch(
          `${fulfillBase.replace(/\/$/, "")}/api/internal/fulfill-order`,
          {
            method: "POST",
            headers: internalHeaders,
            body: JSON.stringify({
              orderId: order.id,
              email: order.email,
              items: lineItems.map((it) => ({
                name: it.name,
                sku: it.sku,
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

    /* D) 付款成功 → ezPay 電子發票（失敗不影響發貨；可重試） */
    if (!hasInvoice && fulfillBase) {
      try {
        const amtRaw =
          typeof order.total === "number"
            ? order.total
            : Number(result?.Amt || 0);
        const invoiceRes = await fetch(
          `${fulfillBase.replace(/\/$/, "")}/api/internal/issue-invoice`,
          {
            method: "POST",
            headers: internalHeaders,
            body: JSON.stringify({
              orderId: order.id,
              // ezPay MerchantOrderNo 上限 20；藍新用完整 ULID（≤30）
              orderNo: merchantOrderNo.slice(0, 20),
              email: order.email,
              amount: amtRaw,
              buyerName:
                order.metadata?.buyer_name ||
                order.shipping_address?.first_name ||
                undefined,
              buyerUBN: order.metadata?.buyer_ubn || undefined,
              items: lineItems.map((it) => ({
                name: it.name,
                qty: it.quantity || 1,
                price:
                  it.unit_price != null
                    ? it.unit_price
                    : Math.round(amtRaw / Math.max(1, lineItems.length)),
              })),
            }),
          },
        );
        const invoiceData = await invoiceRes.json().catch(() => ({}));
        if (invoiceRes.ok && invoiceData?.success) {
          if (!invoiceData.skipped && invoiceData.invoiceNumber) {
            await orderModule.updateOrders([
              {
                id: order.id,
                metadata: {
                  ...(order.metadata || {}),
                  ezpay_invoice_number: invoiceData.invoiceNumber,
                  ezpay_invoice_random: invoiceData.randomNum || "",
                  ezpay_invoice_at:
                    invoiceData.createTime || new Date().toISOString(),
                },
              },
            ]);
            console.log(
              `[newebpay-notify:${rid}] 發票開立: ${invoiceData.invoiceNumber}`,
            );
          } else {
            console.log(
              `[newebpay-notify:${rid}] 發票略過:`,
              invoiceData.message || "disabled",
            );
          }
        } else {
          console.error(
            `[newebpay-notify:${rid}] 發票失敗:`,
            invoiceData?.message || invoiceData,
          );
        }
      } catch (invErr: any) {
        console.error(
          `[newebpay-notify:${rid}] 發票例外:`,
          invErr?.message || invErr,
        );
      }
    } else if (hasInvoice) {
      console.log(`[newebpay-notify:${rid}] 發票已開過，略過: ${order.id}`);
    }

    return res.status(200).send("OK");
  } catch (error: any) {
    console.error(`[newebpay-notify:${rid}] 例外:`, error?.message || error);
    return res.status(200).send("OK");
  }
}
