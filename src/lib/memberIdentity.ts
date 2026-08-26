/**
 * 會員身分「蓋章」：結帳完成時把登入身分寫進 Medusa 訂單 metadata，
 * 讓會員中心／手機底部可以依 line_user_id / supabase_user_id / checkout_email
 * 對回本人訂單，而不必讓顧客猜「要用哪個帳號登入才看得到單」。
 *
 * 來源是前端結帳頁帶上的 orderInfo（見 storefront CheckoutForm / checkout/shop）。
 * 這裡只做正規化與白名單挑選，不信任其他欄位。
 */

type OrderInfoLike = {
  lineUserId?: unknown;
  supabaseUserId?: unknown;
  authProvider?: unknown;
  customerId?: unknown;
  email?: unknown;
} | null | undefined;

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

const LINE_USER_ID_RE = /^U[0-9a-f]{32}$/i;

/** 只接受合法 LINE user id（U + 32 hex），避免寫入垃圾值 */
function cleanLineUserId(value: unknown): string | null {
  const s = cleanString(value);
  if (!s) return null;
  return LINE_USER_ID_RE.test(s) ? s : null;
}

/** 驗證通過後才回傳合法 provider */
function cleanAuthProvider(value: unknown): string | null {
  const s = cleanString(value);
  if (!s) return null;
  const lower = s.toLowerCase();
  return ["supabase", "line", "guest"].includes(lower) ? lower : null;
}

/**
 * 產生要併入 order.metadata 的身分欄位。
 * 只回傳有值的鍵，避免覆寫既有 metadata 成 null。
 */
export function buildMemberIdentityMetadata(
  orderInfo: OrderInfoLike,
  fallbackEmail?: unknown,
): Record<string, string> {
  const meta: Record<string, string> = {};

  const lineUserId = cleanLineUserId(orderInfo?.lineUserId);
  if (lineUserId) meta.line_user_id = lineUserId;

  const supabaseUserId = cleanString(
    orderInfo?.supabaseUserId ?? orderInfo?.customerId,
  );
  if (supabaseUserId) meta.supabase_user_id = supabaseUserId;

  const authProvider = cleanAuthProvider(orderInfo?.authProvider);
  if (authProvider) meta.auth_provider = authProvider;

  const checkoutEmail = cleanString(orderInfo?.email) ?? cleanString(fallbackEmail);
  if (checkoutEmail) meta.checkout_email = checkoutEmail.toLowerCase();

  return meta;
}
