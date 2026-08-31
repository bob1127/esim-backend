/**
 * 付款成功後發貨備案：重試 + 已 subscribe 的 topup 改走 fulfill-from-topup（避免重複開卡）
 */

export type FulfillLineItem = {
  name?: string
  sku?: string
  planId?: string
  quantity?: number
}

export type TopupRef = {
  topupId: string
  productName?: string
}

export type FulfillResult = {
  ok: boolean
  qrcodes: any[]
  message: string
  topupIds: TopupRef[]
  attempts: number
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function normalizeQrSrc(raw: unknown): string {
  const str = String(raw || "")
  if (!str) return ""
  return str.startsWith("http") || str.startsWith("data:image/")
    ? str
    : `data:image/png;base64,${str}`
}

export function stringifyEsimQrcodes(qrcodes: any[]): string {
  return JSON.stringify(
    (Array.isArray(qrcodes) ? qrcodes : []).map((q: any) => ({
      ...q,
      name: q?.name || "eSIM",
      src: normalizeQrSrc(q?.src),
    })),
  )
}

function mergeTopupIds(
  a: TopupRef[] = [],
  b: TopupRef[] = [],
): TopupRef[] {
  const map = new Map<string, TopupRef>()
  for (const t of [...a, ...b]) {
    const id = String(t?.topupId || "").trim()
    if (!id) continue
    map.set(id, {
      topupId: id,
      productName: t.productName || map.get(id)?.productName || "eSIM",
    })
  }
  return [...map.values()]
}

async function postJson(
  url: string,
  secret: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; data: any }> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Fulfillment-Secret": secret,
    },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, data }
}

async function fulfillFromKnownTopups(opts: {
  base: string
  secret: string
  orderId: string
  email?: string
  topupIds: TopupRef[]
}): Promise<{ ok: boolean; qrcodes: any[]; message: string }> {
  const { base, secret, orderId, email, topupIds } = opts
  const qrcodes: any[] = []
  const errors: string[] = []

  for (const t of topupIds) {
    const { ok, data } = await postJson(
      `${base}/api/internal/fulfill-from-topup`,
      secret,
      {
        orderId,
        topupId: t.topupId,
        email: qrcodes.length === 0 ? email : undefined, // 只在第一張寄一次信
        productName: t.productName || "eSIM",
      },
    )
    if (ok && Array.isArray(data?.qrcodes) && data.qrcodes.length) {
      qrcodes.push(...data.qrcodes)
    } else {
      errors.push(String(data?.message || `topup ${t.topupId} failed`))
    }
  }

  if (qrcodes.length) {
    return { ok: true, qrcodes, message: "fulfill-from-topup ok" }
  }
  return {
    ok: false,
    qrcodes: [],
    message: errors.join("; ") || "fulfill-from-topup failed",
  }
}

/**
 * 1) 呼叫 fulfill-order（最多 attempts 次，間隔 delaysMs）
 * 2) 若已有 topupIds（訂閱成功但後續炸）→ 改 fulfill-from-topup，不再重訂
 */
export async function fulfillPaidOrderWithRetry(opts: {
  fulfillBase: string
  fulfillSecret: string
  orderId: string
  email?: string
  items: FulfillLineItem[]
  existingTopupIds?: TopupRef[]
  /** 預設 3；含第一次 */
  attempts?: number
  /** 第 2、3 次前等待；預設 20s、60s */
  delaysMs?: number[]
  logPrefix?: string
}): Promise<FulfillResult> {
  const base = String(opts.fulfillBase || "").replace(/\/$/, "")
  const secret = String(opts.fulfillSecret || "")
  const log = opts.logPrefix || "[fulfill-retry]"
  const maxAttempts = Math.max(1, opts.attempts ?? 3)
  const delays = opts.delaysMs || [20_000, 60_000]

  if (!base || secret.length < 16) {
    return {
      ok: false,
      qrcodes: [],
      message: "缺少 FULFILLMENT_INTERNAL_URL / SECRET",
      topupIds: opts.existingTopupIds || [],
      attempts: 0,
    }
  }

  let topupIds = mergeTopupIds(opts.existingTopupIds || [])
  let lastMessage = ""

  // 已有 topup：優先補齊，避免重複開卡
  if (topupIds.length) {
    console.log(`${log} 既有 topup ${topupIds.length} 筆，走 fulfill-from-topup`)
    const fromTopup = await fulfillFromKnownTopups({
      base,
      secret,
      orderId: opts.orderId,
      email: opts.email,
      topupIds,
    })
    if (fromTopup.ok) {
      return {
        ok: true,
        qrcodes: fromTopup.qrcodes,
        message: fromTopup.message,
        topupIds,
        attempts: 0,
      }
    }
    lastMessage = fromTopup.message
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      const delay = delays[attempt - 2] ?? delays[delays.length - 1] ?? 30_000
      console.warn(`${log} 第 ${attempt}/${maxAttempts} 次重試前等待 ${delay}ms`)
      await sleep(delay)
    }

    // 若上一輪已拿到 topup，不要再 subscribe
    if (topupIds.length) {
      const fromTopup = await fulfillFromKnownTopups({
        base,
        secret,
        orderId: opts.orderId,
        email: opts.email,
        topupIds,
      })
      if (fromTopup.ok) {
        return {
          ok: true,
          qrcodes: fromTopup.qrcodes,
          message: fromTopup.message,
          topupIds,
          attempts: attempt,
        }
      }
      lastMessage = fromTopup.message
      continue
    }

    try {
      const { ok, status, data } = await postJson(
        `${base}/api/internal/fulfill-order`,
        secret,
        {
          orderId: opts.orderId,
          email: opts.email,
          items: opts.items,
        },
      )

      const returnedTopups = Array.isArray(data?.topupIds)
        ? data.topupIds
            .map((t: any) => ({
              topupId: String(t?.topupId || t || "").trim(),
              productName: String(t?.productName || "eSIM"),
            }))
            .filter((t: TopupRef) => t.topupId)
        : []
      topupIds = mergeTopupIds(topupIds, returnedTopups)

      if (ok && Array.isArray(data?.qrcodes) && data.qrcodes.length) {
        return {
          ok: true,
          qrcodes: data.qrcodes,
          message: String(data?.message || "ok"),
          topupIds,
          attempts: attempt,
        }
      }

      lastMessage = String(data?.message || `HTTP ${status}`)
      console.error(`${log} fulfill-order 失敗 attempt=${attempt}:`, lastMessage)

      // 已 subscribe：下一輪改 from-topup
      if (topupIds.length) {
        const fromTopup = await fulfillFromKnownTopups({
          base,
          secret,
          orderId: opts.orderId,
          email: opts.email,
          topupIds,
        })
        if (fromTopup.ok) {
          return {
            ok: true,
            qrcodes: fromTopup.qrcodes,
            message: fromTopup.message,
            topupIds,
            attempts: attempt,
          }
        }
        lastMessage = fromTopup.message || lastMessage
      }
    } catch (e: any) {
      lastMessage = String(e?.message || e)
      console.error(`${log} fulfill-order 例外 attempt=${attempt}:`, lastMessage)
    }
  }

  return {
    ok: false,
    qrcodes: [],
    message: lastMessage || "fulfill failed after retries",
    topupIds,
    attempts: maxAttempts,
  }
}
