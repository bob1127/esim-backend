/**
 * 本地 E2E：無藍新金鑰時模擬 notify 的 referral 分支（capture + Supabase sync）
 *
 *   npx medusa exec ./src/scripts/simulate-referral-paid.ts <ORDER_ID> [REFERRAL_CODE]
 */
import { ExecArgs } from "@medusajs/framework/types";
import {
  resolveTwdAmount,
  sumLineItemsAmount,
  loadOrderPayableAmount,
} from "../lib/orderAmount";
import {
  upsertReferralOrderToSupabase,
  buildReferralOrderMetadata,
} from "../lib/referralOrderSync";

export default async function simulateReferralPaid({
  container,
  args,
}: ExecArgs) {
  const raw = String(args?.[0] || "").trim();
  const referralCodeArg = String(args?.[1] || "").trim();
  if (!raw) {
    throw new Error(
      "用法: npx medusa exec ./src/scripts/simulate-referral-paid.ts <ORDER_ID> [REFERRAL_CODE]",
    );
  }
  const orderId = raw.startsWith("order_") ? raw : `order_${raw}`;
  const merchantOrderNo = orderId.replace(/^order_/, "");

  const query = container.resolve("query") as {
    graph: (args: Record<string, unknown>) => Promise<{ data: any[] }>;
  };
  const orderModule = container.resolve("order") as {
    updateOrders: (
      data: Array<{ id: string; metadata: Record<string, unknown> }>,
    ) => Promise<unknown>;
  };
  const paymentModule = container.resolve("payment") as {
    authorizePaymentSession: (id: string, ctx: Record<string, unknown>) => Promise<{ id?: string }>;
    capturePayment: (args: { payment_id: string; amount: number }) => Promise<unknown>;
  };

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
      "items.product_id",
      "items.variant_sku",
      "items.quantity",
      "items.unit_price",
      "items.subtotal",
      "items.total",
      "items.metadata",
      "items.variant.id",
      "items.variant.sku",
      "items.variant.metadata",
      "payment_collections.payment_sessions.id",
    ],
    filters: { id: [orderId] },
  });

  const order = orders?.[0];
  if (!order) throw new Error(`找不到訂單 ${orderId}`);

  const expected =
    resolveTwdAmount(order.total, sumLineItemsAmount(order.items)) ||
    (await loadOrderPayableAmount(container, order.id, 0));

  const meta: Record<string, unknown> = { ...(order.metadata || {}) };
  if (referralCodeArg && !meta.jeko_referral_code) {
    meta.jeko_referral_code = referralCodeArg;
  }
  if (!meta.jeko_referral_code) {
    throw new Error("訂單缺少 jeko_referral_code，請傳入第二參數");
  }

  const alreadyPaid = !!meta.newebpay_pay_time;
  if (!alreadyPaid && order.payment_status !== "captured") {
    const sessionId =
      order.payment_collections?.[0]?.payment_sessions?.[0]?.id;
    if (!sessionId) {
      throw new Error("找不到 payment session，無法 capture");
    }
    const payment = await paymentModule.authorizePaymentSession(sessionId, {});
    if (payment?.id) {
      await paymentModule.capturePayment({
        payment_id: payment.id,
        amount: expected,
      });
    }
  }

  const referral = await upsertReferralOrderToSupabase({
    order: { ...order, metadata: meta },
    merchantOrderNo,
    totalAmount: expected,
    payType: "CREDIT",
    paymentProvider: "newebpay",
    query,
  });
  const referralMeta = buildReferralOrderMetadata(referral);

  await orderModule.updateOrders([
    {
      id: order.id,
      metadata: {
        ...meta,
        newebpay_merchant_order_no: merchantOrderNo,
        newebpay_amount: expected,
        newebpay_payment_type: "CREDIT",
        newebpay_trade_no: `E2E-${Date.now()}`,
        newebpay_pay_time: new Date().toISOString(),
        ...referralMeta,
      },
    },
  ]);

  console.log(
    JSON.stringify(
      {
        orderId: order.id,
        expected,
        referral,
        payment_status: "captured (simulated)",
      },
      null,
      2,
    ),
  );
}
