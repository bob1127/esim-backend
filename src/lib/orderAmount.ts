/**
 * 訂單金額安全解析（TWD 整數）。
 *
 * 原則：
 * 1. 金額永遠以 Medusa DB（cart / order）為準，絕不信任前端傳值。
 * 2. 解析不到正數金額一律回 0，由呼叫端拒絕交易——禁止任何「兜底 1 元」行為。
 * 3. 付款確認（confirm / notify）時必須與建單金額交叉核對，不一致即中止。
 *
 * 注意：Medusa v2 在 cart complete 後，store/carts 回傳的 total／items 會變成 0／[]，
 * 不可再從「已完成的 cart」讀金額；必須改查 order（含 items）。
 */

type MedusaScope = {
  resolve: (key: string) => unknown
}

/** 解析 TWD 整數金額；解析不到正數回 0（呼叫端必須拒絕 0） */
export function resolveTwdAmount(...candidates: unknown[]): number {
  for (const raw of candidates) {
    if (raw == null || raw === "") continue
    if (typeof raw === "object") {
      const obj = raw as Record<string, unknown>
      // Medusa BigNumber raw：{ value: "109", precision: 20 }
      const nested = resolveTwdAmount(
        obj.numeric,
        obj.value,
        obj.amount,
        obj.total,
        obj.calculated_amount,
        obj.raw_total,
        obj.raw_current_order_total
      )
      if (nested > 0) return nested
      continue
    }
    const n = Number(raw)
    if (Number.isFinite(n) && n > 0) return Math.round(n)
  }
  return 0
}

/** 明細加總（unit_price × quantity 為最後備援） */
export function sumLineItemsAmount(items: unknown): number {
  if (!Array.isArray(items) || !items.length) return 0
  return items.reduce((sum: number, item: any) => {
    const line = resolveTwdAmount(
      item?.total,
      item?.subtotal,
      item?.raw_total,
      item?.raw_subtotal,
      Number(resolveTwdAmount(item?.unit_price, item?.raw_unit_price) || 0) *
        Number(item?.quantity || 1)
    )
    return sum + line
  }, 0)
}

function amountFromOrderLike(full: any): number {
  if (!full) return 0
  return resolveTwdAmount(
    full.total,
    full.summary?.total,
    full.summary?.raw_current_order_total,
    full.summary?.totals?.total,
    full.summary?.current_order_total,
    full.item_total,
    full.subtotal,
    sumLineItemsAmount(full.items),
    // payment collection 金額（建單後常仍保留應付額）
    full.payment_collections?.[0]?.amount,
    full.payment_collection?.amount
  )
}

/**
 * 從 DB 重新載入訂單應付金額。
 * fallback 亦須來自伺服器端計算（例如結帳前、items 仍在時的 cart total），不可來自前端。
 */
export async function loadOrderPayableAmount(
  scope: MedusaScope,
  orderId: string,
  fallback = 0
): Promise<number> {
  if (!orderId) return fallback

  try {
    const query = scope.resolve("query") as {
      graph: (args: Record<string, unknown>) => Promise<{ data: any[] }>
    }
    const { data } = await query.graph({
      entity: "order",
      fields: [
        "id",
        "total",
        "subtotal",
        "item_total",
        "summary.*",
        "items.quantity",
        "items.unit_price",
        "items.subtotal",
        "items.total",
        "items.raw_unit_price",
        "items.raw_total",
        "items.raw_subtotal",
        "payment_collections.amount",
        "payment_collection.amount",
      ],
      filters: { id: [orderId] },
    })
    const full = data?.[0]
    const fromGraph = amountFromOrderLike(full)
    if (fromGraph > 0) return fromGraph
  } catch (err) {
    console.warn(
      "[orderAmount] query.graph 載入訂單金額失敗:",
      (err as Error)?.message || err
    )
  }

  // 備援：order module retrieve（部分環境 graph 算不出 total）
  try {
    const orderModule = scope.resolve("order") as {
      retrieveOrder?: (
        id: string,
        config?: Record<string, unknown>
      ) => Promise<any>
    }
    if (typeof orderModule?.retrieveOrder === "function") {
      const order = await orderModule.retrieveOrder(orderId, {
        relations: ["items", "summary"],
      })
      const fromModule = amountFromOrderLike(order)
      if (fromModule > 0) return fromModule
    }
  } catch (err) {
    console.warn(
      "[orderAmount] order.retrieveOrder 載入金額失敗:",
      (err as Error)?.message || err
    )
  }

  return fallback
}

/**
 * 交叉核對付款金額與訂單金額。
 * 回傳 null 表示通過；否則回傳拒絕原因（呼叫端應中止並記錄）。
 */
export function verifyPaymentAmount({
  expected,
  reserved,
  paid,
}: {
  /** DB 重新計算的訂單應付金額 */
  expected: number
  /** 建單（reserve）時送給金流的金額（如 metadata 記錄） */
  reserved?: number
  /** 金流回報的實付金額（如藍新 notify 的 Amt） */
  paid?: number
}): string | null {
  if (!Number.isFinite(expected) || expected < 1) {
    return `訂單金額異常（expected=${expected}），拒絕交易`
  }
  if (reserved != null && reserved > 0 && reserved !== expected) {
    return `建單金額與訂單金額不符（reserved=${reserved}, expected=${expected}）`
  }
  if (paid != null && paid > 0 && paid !== expected) {
    return `實付金額與訂單金額不符（paid=${paid}, expected=${expected}）`
  }
  return null
}
