import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { updateLineItemInCartWorkflow } from "@medusajs/core-flows";
import {
  verifyPartnerPricing,
  PartnerPricingPayload,
} from "../../../lib/partnerCheckoutSignature";

/**
 * 夥伴店結帳「定價覆寫」。
 *
 * 由可信的 Next.js 伺服器端（/api/orders/create）在計算出夥伴權威售價後，
 * 以共享密鑰 HMAC 簽章呼叫此路由，把每個 line item 的單價覆寫成夥伴售價
 * （updateLineItemInCartWorkflow 帶 unit_price → 自動標記 is_custom_price，
 * 後續 refresh 不會被變體零售價覆蓋）。並把分潤歸屬寫進 cart.metadata，
 * 供 newebpay-checkout 完成訂單時複製到 order.metadata。
 *
 * 安全：完全不信任「瀏覽器端」傳入的價格；此路由只接受「後端簽章」過的 payload，
 * 密鑰只存在伺服器環境變數。驗簽失敗或超時一律拒絕。
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const { payload, signature } = req.body as {
    payload?: PartnerPricingPayload;
    signature?: string;
  };

  if (!payload || !signature) {
    return res.status(400).json({ message: "缺少 payload 或 signature" });
  }

  const verdict = verifyPartnerPricing(payload, String(signature));
  if (!verdict.ok) {
    console.warn(
      `[apply-partner-pricing] 驗簽失敗: ${verdict.reason} cart=${payload?.cartId}`,
    );
    return res.status(403).json({ message: "定價簽章驗證失敗" });
  }

  const cartId = String(payload.cartId || "");
  if (!cartId) return res.status(400).json({ message: "缺少 cartId" });

  const lines = Array.isArray(payload.lines) ? payload.lines : [];
  if (!lines.length) {
    return res.status(400).json({ message: "缺少定價明細" });
  }

  try {
    const query = req.scope.resolve("query") as {
      graph: (args: Record<string, unknown>) => Promise<{ data: any[] }>;
    };

    // 確認購物車存在且尚未結帳，且 line item 屬於此購物車
    const { data: carts } = await query.graph({
      entity: "cart",
      fields: ["id", "completed_at", "items.id", "items.variant_id"],
      filters: { id: [cartId] },
    });
    const cart = carts?.[0];
    if (!cart) return res.status(404).json({ message: "找不到購物車" });
    if (cart.completed_at) {
      return res.status(409).json({ message: "購物車已結帳，無法調整定價" });
    }

    const validItemIds = new Set(
      (cart.items || []).map((i: any) => String(i.id)),
    );

    // 逐項覆寫單價（帶 unit_price → is_custom_price=true）
    for (const line of lines) {
      const itemId = String(line.item_id);
      const unitPrice = Math.round(Number(line.unit_price) || 0);
      if (!validItemIds.has(itemId)) {
        return res
          .status(400)
          .json({ message: `line item 不屬於此購物車: ${itemId}` });
      }
      if (!(unitPrice > 0)) {
        return res
          .status(400)
          .json({ message: `單價異常: ${itemId}=${unitPrice}` });
      }
      await updateLineItemInCartWorkflow(req.scope).run({
        input: {
          cart_id: cartId,
          item_id: itemId,
          update: { unit_price: unitPrice },
        },
      });
    }

    // 分潤歸屬寫進 cart.metadata（結帳完成時由 newebpay-checkout 複製到 order）
    try {
      const cartModule = req.scope.resolve("cart") as {
        updateCarts: (
          data: Array<{ id: string; metadata: Record<string, unknown> }>,
        ) => Promise<unknown>;
        retrieveCart?: (id: string, opts?: any) => Promise<any>;
      };
      const existingMeta =
        (typeof cartModule.retrieveCart === "function"
          ? (await cartModule.retrieveCart(cartId).catch(() => null))?.metadata
          : null) || {};
      await cartModule.updateCarts([
        {
          id: cartId,
          metadata: {
            ...existingMeta,
            is_partner_order: true,
            partner_store_id: String(payload.storeId ?? ""),
            partner_id:
              payload.partnerId != null ? String(payload.partnerId) : "",
            partner_total: Math.round(Number(payload.total) || 0),
            partner_b2b_cost: Math.round(Number(payload.b2bCost) || 0),
            partner_profit: Math.round(Number(payload.partnerProfit) || 0),
          },
        },
      ]);
    } catch (metaErr: any) {
      console.error(
        "[apply-partner-pricing] 寫入 cart.metadata 失敗:",
        metaErr?.message || metaErr,
      );
    }

    // 回讀套用後的總額
    const { data: after } = await query.graph({
      entity: "cart",
      fields: ["id", "total", "item_total", "subtotal"],
      filters: { id: [cartId] },
    });
    const total =
      Math.round(Number(after?.[0]?.total)) ||
      Math.round(Number(after?.[0]?.item_total)) ||
      Math.round(Number(after?.[0]?.subtotal)) ||
      0;

    return res.status(200).json({ ok: true, total });
  } catch (error: any) {
    console.error("[apply-partner-pricing] 例外:", error?.message || error);
    return res
      .status(500)
      .json({ message: error?.message || "套用夥伴定價失敗" });
  }
}
