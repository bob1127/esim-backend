import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

type QrcodeInfo = { name: string; src: string };

function normalizeSrc(raw: any): string {
  const str = String(raw || "");
  if (!str) return "";
  return str.startsWith("http") || str.startsWith("data:image/")
    ? str
    : `data:image/png;base64,${str}`;
}

/**
 * 給前台 /pending、/thank-you 查詢付款狀態用的公開只讀端點。
 * 回傳格式沿用舊版 esim-store-front `/api/fetch-order` 的 contract，
 * 避免前台頁面需要跟著改。
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const orderNo = String(req.query?.orderNo || "").trim();
  if (!orderNo) {
    return res.status(400).json({ error: "缺少訂單編號（orderNo）" });
  }

  try {
    const query = req.scope.resolve("query") as any;
    const { data: orders } = await query.graph({
      entity: "order",
      fields: ["id", "status", "payment_status", "metadata"],
      filters: { id: [`order_${orderNo}`] },
    });

    const order = orders?.[0];
    if (!order) {
      return res.status(404).json({ error: "找不到訂單" });
    }

    const meta: Record<string, any> = order.metadata || {};

    let offsiteInfo: any = null;
    if (meta.newebpay_offsite_info) {
      try {
        offsiteInfo =
          typeof meta.newebpay_offsite_info === "string"
            ? JSON.parse(meta.newebpay_offsite_info)
            : meta.newebpay_offsite_info;
      } catch {
        offsiteInfo = null;
      }
    }

    const isPaid =
      order.payment_status === "captured" ||
      order.payment_status === "partially_captured" ||
      !!meta.newebpay_pay_time;

    const paymentType = String(meta.newebpay_payment_type || "");
    const statusLabel = isPaid
      ? "SUCCESS"
      : offsiteInfo
        ? "PENDING"
        : String(order.status || "UNKNOWN").toUpperCase();

    const orderInfo = {
      status: statusLabel,
      isPaid,
      MerchantOrderNo: orderNo,
      PaymentType: paymentType,
      PayTime: String(meta.newebpay_pay_time || ""),
      TradeNo: String(meta.newebpay_trade_no || ""),
      wooStatus: String(order.status || ""),
    };

    let qrcodes: QrcodeInfo[] = [];
    if (meta.esim_qrcodes) {
      try {
        const parsed =
          typeof meta.esim_qrcodes === "string"
            ? JSON.parse(meta.esim_qrcodes)
            : meta.esim_qrcodes;
        if (Array.isArray(parsed)) {
          qrcodes = parsed
            .map((it: any, idx: number) => {
              const name =
                it?.name && String(it.name).trim()
                  ? it.name
                  : `eSIM #${idx + 1}`;
              const src = normalizeSrc(it?.src ?? it);
              return src ? { name, src } : null;
            })
            .filter(Boolean) as QrcodeInfo[];
        }
      } catch {
        qrcodes = [];
      }
    }

    return res.status(200).json({
      orderInfo,
      offsiteInfo,
      offsitePending: !isPaid && !!offsiteInfo,
      qrcodes,
      message: qrcodes.length
        ? undefined
        : isPaid
          ? "尚未找到任何 eSIM QRCode，請稍後再試或聯繫客服。"
          : undefined,
    });
  } catch (error: any) {
    console.error("[newebpay/order-status] 例外:", error?.message || error);
    return res.status(500).json({ error: "查詢失敗", details: error?.message });
  }
}
