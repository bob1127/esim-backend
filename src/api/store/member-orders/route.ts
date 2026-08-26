import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";

/**
 * 會員查單（依 Medusa 為單一真相）。
 *
 * 這支只做「找出屬於這位會員的 Medusa 訂單」，安全把關由 storefront 端
 * （pages/api/orders/user-orders.js）負責：它會先驗證登入者本人，算出可查詢的
 * email 聯集 / customer_id / line_user_id，再帶著內部密鑰呼叫本端點。
 *
 * 查詢條件（聯集去重）：
 *   - email ∈ 已驗證 email 聯集
 *   - customer_id ∈ 綁定的 Medusa customer
 *   - metadata.line_user_id = 本人 LINE user id（結帳蓋章寫入）
 *   - metadata.supabase_user_id = 本人 Supabase user id
 *
 * line_user_id / supabase_user_id 走 SQL 直查 JSONB metadata，能抓到「尚未綁定
 * email」但購買當下已用該身分登入的訂單。
 */

const ORDER_FIELDS = [
  "id",
  "display_id",
  "status",
  "payment_status",
  "fulfillment_status",
  "email",
  "currency_code",
  "total",
  "subtotal",
  "item_total",
  "created_at",
  "updated_at",
  "metadata",
  "customer_id",
  "items.id",
  "items.title",
  "items.product_title",
  "items.variant_title",
  "items.product_id",
  "items.variant_id",
  "items.quantity",
  "items.unit_price",
  "items.total",
  "items.subtotal",
  "items.thumbnail",
  "items.metadata",
];

function assertInternalSecret(req: MedusaRequest, res: MedusaResponse): boolean {
  const expected = [
    process.env.MEMBER_ORDERS_INTERNAL_SECRET,
    process.env.FULFILLMENT_INTERNAL_SECRET,
    process.env.PRODUCT_CONTENT_ADMIN_SECRET,
  ].filter((s): s is string => Boolean(s) && String(s).length >= 24);

  if (expected.length === 0) {
    res.status(500).json({ message: "伺服器未設定內部密鑰" });
    return false;
  }

  const header = String(req.headers["x-internal-secret"] || "").trim();
  if (!header || !expected.includes(header)) {
    res.status(401).json({ message: "Unauthorized" });
    return false;
  }
  return true;
}

function parseList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  }
  return [];
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  if (!assertInternalSecret(req, res)) return;

  const emails = Array.from(
    new Set(parseList(req.query?.emails).map((e) => e.toLowerCase())),
  );
  const customerIds = Array.from(new Set(parseList(req.query?.customer_id)));
  const lineUserId = String(req.query?.line_user_id || "").trim();
  const supabaseUserId = String(req.query?.supabase_user_id || "").trim();

  if (
    emails.length === 0 &&
    customerIds.length === 0 &&
    !lineUserId &&
    !supabaseUserId
  ) {
    return res.status(200).json({ success: true, orders: [] });
  }

  try {
    const pg = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as {
      raw: (
        sql: string,
        bindings?: Record<string, unknown>,
      ) => Promise<{ rows: Array<{ id: string }> }>;
    };

    const clauses: string[] = [];
    const bindings: Record<string, unknown> = {};
    if (emails.length) {
      clauses.push("lower(email) = ANY(:emails)");
      bindings.emails = emails;
    }
    if (customerIds.length) {
      clauses.push("customer_id = ANY(:cids)");
      bindings.cids = customerIds;
    }
    if (lineUserId) {
      clauses.push("metadata->>'line_user_id' = :lid");
      bindings.lid = lineUserId;
    }
    if (supabaseUserId) {
      clauses.push("metadata->>'supabase_user_id' = :sid");
      bindings.sid = supabaseUserId;
    }

    const sql = `
      SELECT id FROM "order"
      WHERE deleted_at IS NULL AND (${clauses.join(" OR ")})
      ORDER BY created_at DESC
      LIMIT 500
    `;

    const result = await pg.raw(sql, bindings);
    const ids = Array.from(new Set((result?.rows || []).map((r) => r.id)));
    if (ids.length === 0) {
      return res.status(200).json({ success: true, orders: [] });
    }

    const query = req.scope.resolve("query") as {
      graph: (args: Record<string, unknown>) => Promise<{ data: any[] }>;
    };
    const { data: orders } = await query.graph({
      entity: "order",
      fields: ORDER_FIELDS,
      filters: { id: ids },
    });

    const sorted = (orders || []).sort(
      (a, b) =>
        new Date(b.created_at || 0).getTime() -
        new Date(a.created_at || 0).getTime(),
    );

    return res.status(200).json({ success: true, orders: sorted });
  } catch (error: any) {
    console.error("[store/member-orders] 查詢失敗:", error?.message || error);
    return res
      .status(500)
      .json({ success: false, message: "會員訂單查詢失敗", detail: error?.message });
  }
}
