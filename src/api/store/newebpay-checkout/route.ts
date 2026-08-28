import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import {
  newebpayAesEncrypt,
  newebpayShaEncrypt,
} from "../../../lib/newebpay/crypto";
import {
  resolveTwdAmount,
  sumLineItemsAmount,
  loadOrderPayableAmount,
} from "../../../lib/orderAmount";
import { buildMemberIdentityMetadata } from "../../../lib/memberIdentity";

const PROVIDER_ID = "pp_newebpay_newebpay";
const SANDBOX_GATEWAY_URL = "https://ccore.newebpay.com/MPG/mpg_gateway";
const PRODUCTION_GATEWAY_URL = "https://core.newebpay.com/MPG/mpg_gateway";
const SUPPORTED_METHODS = [
  "CREDIT",
  "VACC",
  "WEBATM",
  "CVS",
  "BARCODE",
  "LINEPAY",
];

function resolveBackendUrl(req: MedusaRequest): string {
  if (process.env.MEDUSA_BACKEND_URL) {
    return process.env.MEDUSA_BACKEND_URL.replace(/\/$/, "");
  }
  const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
  if (railwayDomain) return `https://${railwayDomain}`;
  const host = req.get("host");
  if (host) return `${(req.protocol || "https")}://${host}`;
  return "http://localhost:9000";
}

function resolveStoreUrl(): string {
  return (process.env.STORE_URL || "https://www.jeko-esim.com.tw").replace(
    /\/$/,
    "",
  );
}

function resolveGatewayUrl(): string {
  if (process.env.NEWEBPAY_GATEWAY_URL) return process.env.NEWEBPAY_GATEWAY_URL;
  return process.env.NEWEBPAY_ENV === "production"
    ? PRODUCTION_GATEWAY_URL
    : SANDBOX_GATEWAY_URL;
}

async function storeFetch(
  backendUrl: string,
  path: string,
  headers: Record<string, string>,
  init?: RequestInit,
) {
  const response = await fetch(`${backendUrl}${path}`, {
    ...init,
    headers: { ...headers, ...(init?.headers as Record<string, string>) },
  });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** 409 / race 時：輪詢 cart.completed_at，再用 order module 依 email+時間找回訂單 */
async function recoverOrderAfterComplete(
  req: MedusaRequest,
  backendUrl: string,
  headers: Record<string, string>,
  cartId: string,
) {
  let cartEmail: string | undefined;
  for (let attempt = 0; attempt < 8; attempt++) {
    const cartRes = await storeFetch(
      backendUrl,
      `/store/carts/${cartId}`,
      headers,
    );
    const cart = cartRes.data?.cart;
    cartEmail = cart?.email || cartEmail;
    if (cart?.completed_at) break;
    await sleep(300 + attempt * 150);
  }

  // 優先：query graph 以 cart_id 關聯找 order（Medusa v2 link）
  try {
    const query = req.scope.resolve("query") as {
      graph: (args: Record<string, unknown>) => Promise<{ data: any[] }>;
    };
    const { data: carts } = await query.graph({
      entity: "cart",
      fields: ["id", "email", "completed_at", "order.id", "order.email", "order.total", "order.metadata"],
      filters: { id: [cartId] },
    });
    const linked = carts?.[0]?.order;
    if (linked?.id) return linked;
  } catch (err) {
    console.warn("[newebpay-checkout] cart→order graph 查詢失敗:", err);
  }

  // 備援：最近訂單（同 email）
  if (cartEmail) {
    try {
      const query = req.scope.resolve("query") as {
        graph: (args: Record<string, unknown>) => Promise<{ data: any[] }>;
      };
      const { data: orders } = await query.graph({
        entity: "order",
        fields: ["id", "email", "total", "metadata", "created_at"],
        filters: { email: cartEmail },
      });
      const sorted = (orders || []).sort(
        (a, b) =>
          new Date(b.created_at || 0).getTime() -
          new Date(a.created_at || 0).getTime(),
      );
      if (sorted[0]?.id) return sorted[0];
    } catch (err) {
      console.warn("[newebpay-checkout] order email 查詢失敗:", err);
    }
  }

  return null;
}

async function completeMedusaOrder(
  req: MedusaRequest,
  backendUrl: string,
  headers: Record<string, string>,
  cartId: string,
) {
  const idempotencyKey = `newebpay_complete_${cartId}`;

  // 若 cart 已完成（重試付款表單），直接找回訂單
  const existingCart = await storeFetch(
    backendUrl,
    `/store/carts/${cartId}`,
    headers,
  );
  if (existingCart.data?.cart?.completed_at) {
    const recovered = await recoverOrderAfterComplete(
      req,
      backendUrl,
      headers,
      cartId,
    );
    if (recovered) return recovered;
  }

  const payColRes = await storeFetch(
    backendUrl,
    "/store/payment-collections",
    headers,
    { method: "POST", body: JSON.stringify({ cart_id: cartId }) },
  );
  const payColId = payColRes.data?.payment_collection?.id;
  if (!payColId) {
    console.error(
      "[newebpay-checkout] payment-collections 失敗:",
      payColRes.response.status,
      payColRes.data,
    );
    throw new Error("無法建立付款流程，請稍後再試。");
  }

  const sessionRes = await storeFetch(
    backendUrl,
    `/store/payment-collections/${payColId}/payment-sessions`,
    headers,
    { method: "POST", body: JSON.stringify({ provider_id: PROVIDER_ID }) },
  );
  if (!sessionRes.response.ok) {
    console.error(
      "[newebpay-checkout] payment-sessions 失敗:",
      sessionRes.response.status,
      sessionRes.data,
    );
  }

  const completeRes = await storeFetch(
    backendUrl,
    `/store/carts/${cartId}/complete`,
    headers,
    { method: "POST", headers: { "Idempotency-Key": idempotencyKey } },
  );

  if (completeRes.response.ok && completeRes.data?.type === "order") {
    return completeRes.data.order;
  }

  // 409：另一請求正在 / 已完成結帳；輪詢找回訂單（store/orders 需登入會 401）
  if (
    completeRes.response.status === 409 ||
    existingCart.data?.cart ||
    completeRes.data?.type === "cart"
  ) {
    const recovered = await recoverOrderAfterComplete(
      req,
      backendUrl,
      headers,
      cartId,
    );
    if (recovered) {
      console.log(
        `[newebpay-checkout] 自 race/409 恢復訂單: ${recovered.id}`,
      );
      return recovered;
    }
  }

  throw new Error(
    completeRes.data?.message || "訂單建立失敗，請聯絡客服或稍後再試。",
  );
}

function normalizeMethods(input?: string | string[]): string[] {
  if (!input) return [];
  const arr = Array.isArray(input) ? input : String(input).split(",");
  const uniq = Array.from(
    new Set(arr.map((s) => String(s).trim().toUpperCase()).filter(Boolean)),
  );
  return uniq.filter((m) => SUPPORTED_METHODS.includes(m));
}

function buildFlags(methods: string[]) {
  const flags: Record<string, string> = {
    CREDIT: "0",
    VACC: "0",
    WEBATM: "0",
    CVS: "0",
    BARCODE: "0",
    LINEPAY: "0",
  };
  methods.forEach((m) => {
    if (m in flags) flags[m] = "1";
  });
  return flags;
}

function formatExpire(ts: number) {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    ExpireDate: `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`,
    ExpireTime: `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`,
  };
}

/** order.id 例如 order_01J8X7ZQK3YV2E9T3RCEXAMPLE，去掉 order_ 前綴後恰為 26 碼 ULID，安全落在藍新 30 碼限制內 */
function toMerchantOrderNo(orderId: string): string {
  return orderId.replace(/^order_/, "");
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const { cart_id, orderInfo } = req.body as {
    cart_id?: string;
    orderInfo?: Record<string, any>;
  };

  const pubKey = req.headers["x-publishable-api-key"] as string;
  if (!pubKey) {
    return res.status(400).json({ message: "缺少 x-publishable-api-key" });
  }
  if (!cart_id) {
    return res.status(400).json({ message: "缺少 cart_id" });
  }

  const merchantId = process.env.NEWEBPAY_MERCHANT_ID;
  const hashKey = process.env.NEWEBPAY_HASH_KEY;
  const hashIv = process.env.NEWEBPAY_HASH_IV;
  if (!merchantId || !hashKey || !hashIv) {
    return res.status(503).json({ message: "伺服器尚未設定藍新金流金鑰" });
  }

  const backendUrl = resolveBackendUrl(req);
  const storeUrl = resolveStoreUrl();
  const internalHeaders = {
    "Content-Type": "application/json",
    "x-publishable-api-key": pubKey,
  };

  try {
    const order = await completeMedusaOrder(
      req,
      backendUrl,
      internalHeaders,
      cart_id,
    );
    if (!order?.id) {
      return res.status(500).json({ message: "訂單建立失敗，請聯絡客服或稍後再試。" });
    }

    const merchantOrderNo = toMerchantOrderNo(order.id);
    // 金額一律由 DB 重新計算，禁止 1 元兜底；orderInfo.totalPrice（前端值）僅供比對記錄，不採用
    const amount =
      resolveTwdAmount(order.total, sumLineItemsAmount((order as any).items)) ||
      (await loadOrderPayableAmount(req.scope, order.id, 0));
    if (!amount || amount < 1) {
      return res.status(400).json({
        message: `訂單金額異常（${amount || 0}），無法建立藍新付款。請確認購物車商品價格後重試。`,
        orderId: order.id,
      });
    }
    const email = order.email || orderInfo?.email || "customer@example.com";

    // 夥伴店訂單：把 cart.metadata 內「已由簽章驗證過」的分潤歸屬複製到 order，
    // 供藍新 notify 付款成功後寫回 Supabase 供結算。金額仍以 order.total（＝夥伴
    // 售價，已由 apply-partner-pricing 覆寫）為準，不採信前端傳來的任何金額。
    let partnerMeta: Record<string, unknown> = {};
    try {
      const query = req.scope.resolve("query") as {
        graph: (args: Record<string, unknown>) => Promise<{ data: any[] }>;
      };
      const { data: carts } = await query.graph({
        entity: "cart",
        fields: ["id", "metadata"],
        filters: { id: [cart_id] },
      });
      const cm = (carts?.[0]?.metadata || {}) as Record<string, unknown>;
      if (cm.is_partner_order) {
        partnerMeta = {
          is_partner_order: true,
          partner_store_id: cm.partner_store_id ?? "",
          partner_id: cm.partner_id ?? "",
          partner_total: cm.partner_total ?? amount,
          partner_b2b_cost: cm.partner_b2b_cost ?? 0,
          partner_profit: cm.partner_profit ?? 0,
        };
      } else if (cm.jeko_referral_code) {
        partnerMeta = {
          jeko_referral_code: String(cm.jeko_referral_code),
        };
      }
    } catch (cmErr) {
      console.error("⚠️ [newebpay-checkout] 讀取 cart 分潤 metadata 失敗:", cmErr);
    }

    try {
      const orderModule = req.scope.resolve("order") as {
        updateOrders: (
          data: Array<{ id: string; metadata: Record<string, unknown> }>,
        ) => Promise<unknown>;
      };
      await orderModule.updateOrders([
        {
          id: order.id,
          metadata: {
            ...(order.metadata || {}),
            newebpay_merchant_order_no: merchantOrderNo,
            newebpay_amount: amount,
            // 會員身分「蓋章」：讓會員中心可依此對回本人訂單
            ...buildMemberIdentityMetadata(orderInfo, email),
            ...partnerMeta,
          },
        },
      ]);
    } catch (metaErr) {
      console.error("⚠️ [newebpay-checkout] 寫入 metadata 失敗:", metaErr);
    }

    const envAllowed = normalizeMethods(
      process.env.NEWEBPAY_ALLOWED_METHODS || "CREDIT,VACC,WEBATM",
    );
    const requested = normalizeMethods(
      orderInfo?.methods ?? orderInfo?.method,
    );
    const chosen = requested.length
      ? envAllowed.filter((m) => requested.includes(m))
      : envAllowed;
    const methods = chosen.length ? chosen : ["CREDIT"];
    const flags = buildFlags(methods);

    const needExpire = methods.some((m) => ["VACC", "CVS", "BARCODE"].includes(m));
    const expireMinutes = Number(orderInfo?.expireMinutes ?? 1440);
    const { ExpireDate, ExpireTime } = needExpire
      ? formatExpire(Date.now() + Math.max(1, expireMinutes) * 60 * 1000)
      : { ExpireDate: undefined, ExpireTime: undefined };

    const tradeInfoObj: Record<string, string> = {
      MerchantID: merchantId,
      RespondType: "JSON",
      TimeStamp: `${Math.floor(Date.now() / 1000)}`,
      Version: "2.3",
      MerchantOrderNo: merchantOrderNo,
      Amt: String(amount),
      ItemDesc: "eSIM 訂單",
      Email: email,
      ReturnURL: `${backendUrl}/newebpay/return`,
      NotifyURL: `${backendUrl}/newebpay/notify`,
      CustomerURL: `${backendUrl}/newebpay/customer?orderNo=${encodeURIComponent(merchantOrderNo)}`,
      ClientBackURL: `${storeUrl}/thank-you?orderNo=${encodeURIComponent(merchantOrderNo)}`,
      PaymentMethod: methods.join(","),
      CREDIT: flags.CREDIT,
      VACC: flags.VACC,
      WEBATM: flags.WEBATM,
      CVS: flags.CVS,
      BARCODE: flags.BARCODE,
      LINEPAY: flags.LINEPAY,
    };
    if (needExpire && ExpireDate && ExpireTime) {
      tradeInfoObj.ExpireDate = ExpireDate;
      tradeInfoObj.ExpireTime = ExpireTime;
    }

    const encrypted = newebpayAesEncrypt(tradeInfoObj, hashKey, hashIv);
    const tradeSha = newebpayShaEncrypt(encrypted, hashKey, hashIv);
    const gatewayUrl = resolveGatewayUrl();

    const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /></head>
<body>
<form id="newebpay-form" method="post" action="${gatewayUrl}">
  <input type="hidden" name="MerchantID" value="${merchantId}" />
  <input type="hidden" name="TradeInfo" value="${encrypted}" />
  <input type="hidden" name="TradeSha" value="${tradeSha}" />
  <input type="hidden" name="Version" value="2.3" />
</form>
<script>document.getElementById("newebpay-form").submit();</script>
</body>
</html>`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(html);
  } catch (error: any) {
    console.error("🔥 [newebpay-checkout] 例外:", error);
    return res.status(500).json({ message: error.message || "結帳失敗" });
  }
}
