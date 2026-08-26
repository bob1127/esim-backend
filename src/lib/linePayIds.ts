/**
 * LINE Pay transactionId 是 19 位整數。JSON.parse 會把它變成 JS Number，
 * 超過 Number.MAX_SAFE_INTEGER（約 16 位）後精度遺失，導致建單記錄與
 * 回調網址上的 transactionId 對不上、誤拒請款。
 *
 * 一律：
 * 1. 從原始 JSON 文字用 regex 抽出數字字串（尚未被 Number 化）
 * 2. 寫入 metadata 時加 "lp:" 前綴，避免 jsonb／ORM 再把它當數字
 */

const TX_PREFIX = "lp:"

/** 從原始 JSON 字串抽出指定欄位的數字／字串值（保留完整位數） */
export function extractJsonStringField(raw: string, field: string): string {
  if (!raw || !field) return ""
  const re = new RegExp(`"${field}"\\s*:\\s*(?:"([^"]+)"|(\\d+))`)
  const m = raw.match(re)
  return String(m?.[1] || m?.[2] || "").trim()
}

/** 正規化成可比較／可儲存的字串（去掉 lp: 前綴） */
export function normalizeLinePayTxId(raw: unknown): string {
  const s = String(raw ?? "").trim()
  if (!s) return ""
  return s.startsWith(TX_PREFIX) ? s.slice(TX_PREFIX.length) : s
}

/** 寫入 metadata 用：加前綴，避免被當 Number */
export function storeLinePayTxId(raw: unknown): string {
  const id = normalizeLinePayTxId(raw)
  if (!id) return ""
  return `${TX_PREFIX}${id}`
}
