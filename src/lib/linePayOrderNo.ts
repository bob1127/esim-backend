/** LINE Pay merchant orderId ↔ Medusa cart（付款成功前不建 order） */

export function cartIdToLinePayOrderNo(cartId: string): string {
  const bare = String(cartId || "")
    .trim()
    .replace(/^cart_/i, "")
  if (!bare) throw new Error("無效的 cart_id")
  // 前綴 C：與舊流程「order_ 去掉前綴」區隔，confirm 可分流
  return `C${bare}`
}

export function linePayOrderNoToCartId(orderNo: string): string | null {
  const s = String(orderNo || "").trim()
  if (!s) return null
  if (/^C[0-9A-Z]+$/i.test(s) && !/^cart_/i.test(s)) {
    return `cart_${s.slice(1)}`
  }
  return null
}

export function isCartBasedLinePayOrderNo(orderNo: string): boolean {
  return Boolean(linePayOrderNoToCartId(orderNo))
}
