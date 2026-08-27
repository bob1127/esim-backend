/**
 * 補發 eSIM／開票（付款成功但 QR／信／發票沒跑完時用）
 *
 * 用法（在 esim-backend）：
 *   npx medusa exec ./src/scripts/retry-fulfill-order.ts order_01M0Z1GFZN0BXA61TJ8RHGT4ZE
 * 或只傳 orderNo：
 *   npx medusa exec ./src/scripts/retry-fulfill-order.ts 01M0Z1GFZN0BXA61TJ8RHGT4ZE
 *
 * 環境：FULFILLMENT_INTERNAL_URL、FULFILLMENT_INTERNAL_SECRET
 * 正式站補發請設：
 *   FULFILLMENT_INTERNAL_URL=https://www.jeko-esim.com.tw
 */
import { ExecArgs } from "@medusajs/framework/types"

function normalizeQrSrc(raw: unknown): string {
  const str = String(raw || "")
  if (!str) return ""
  return str.startsWith("http") || str.startsWith("data:image/")
    ? str
    : `data:image/png;base64,${str}`
}

function resolveOrderId(raw: string): string {
  const s = String(raw || "").trim()
  if (!s) return ""
  return s.startsWith("order_") ? s : `order_${s}`
}

export default async function retryFulfillOrder({ container, args }: ExecArgs) {
  const orderId = resolveOrderId(String(args?.[0] || ""))
  if (!orderId) {
    throw new Error("請傳訂單 id 或 orderNo，例如：01M0Z1GFZN0BXA61TJ8RHGT4ZE")
  }

  const fulfillBase = (process.env.FULFILLMENT_INTERNAL_URL || "").replace(/\/$/, "")
  const fulfillSecret = process.env.FULFILLMENT_INTERNAL_SECRET || ""
  if (!fulfillBase || fulfillSecret.length < 16) {
    throw new Error(
      "缺少 FULFILLMENT_INTERNAL_URL / FULFILLMENT_INTERNAL_SECRET（正式站 URL 應為 https://www.jeko-esim.com.tw）",
    )
  }

  const query = container.resolve("query") as {
    graph: (args: Record<string, unknown>) => Promise<{ data: any[] }>
  }
  const orderModule = container.resolve("order") as {
    updateOrders: (
      data: Array<{ id: string; metadata: Record<string, unknown> }>,
    ) => Promise<unknown>
  }

  const { data: orders } = await query.graph({
    entity: "order",
    fields: [
      "id",
      "email",
      "total",
      "metadata",
      "items.title",
      "items.product_title",
      "items.variant_sku",
      "items.quantity",
      "items.unit_price",
      "items.subtotal",
      "items.metadata",
    ],
    filters: { id: [orderId] },
  })
  const order = orders?.[0]
  if (!order) throw new Error(`找不到訂單 ${orderId}`)

  const orderNo = String(order.id).replace(/^order_/, "")
  const amount = Math.round(
    Number(order.metadata?.linepay_amount || order.metadata?.newebpay_amount || order.total || 0),
  )

  const lineItems = (order.items || []).map((it: any) => {
    const qty = Math.max(1, Math.round(Number(it.quantity) || 1))
    const unit =
      typeof it.unit_price === "number"
        ? Math.round(it.unit_price)
        : typeof it.subtotal === "number" && qty
          ? Math.round(Number(it.subtotal) / qty)
          : amount
    return {
      name: it.product_title || it.title || "eSIM",
      sku:
        it.variant_sku ||
        it.metadata?.esim_plan_id ||
        it.metadata?.plan_id ||
        "",
      planId:
        it.metadata?.esim_plan_id ||
        it.metadata?.plan_id ||
        it.metadata?.planId ||
        "",
      quantity: qty,
      unit_price: unit,
    }
  })

  if (!lineItems.length) throw new Error("訂單沒有商品列，無法發貨")

  const headers = {
    "Content-Type": "application/json",
    "X-Fulfillment-Secret": fulfillSecret,
  }

  const patchMeta = async (extra: Record<string, unknown>) => {
    const { data: latestRows } = await query.graph({
      entity: "order",
      fields: ["id", "metadata"],
      filters: { id: [order.id] },
    })
    const latest = latestRows?.[0]
    await orderModule.updateOrders([
      {
        id: order.id,
        metadata: {
          ...(latest?.metadata || order.metadata || {}),
          ...extra,
        },
      },
    ])
  }

  console.log(`[retry-fulfill] order=${order.id} email=${order.email} amount=${amount}`)
  console.log(`[retry-fulfill] items=`, lineItems)
  console.log(`[retry-fulfill] target=${fulfillBase}`)

  // ── 發貨 + 寄信 ──
  if (order.metadata?.esim_qrcodes) {
    console.log("[retry-fulfill] 已有 esim_qrcodes，略過發貨（若要重寄信請先清 metadata）")
  } else {
    const fulfillRes = await fetch(`${fulfillBase}/api/internal/fulfill-order`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        orderId: order.id,
        email: order.email,
        items: lineItems.map((it) => ({
          name: it.name,
          sku: it.sku,
          planId: it.planId,
          quantity: it.quantity,
        })),
      }),
    })
    const fulfillRaw = await fulfillRes.text()
    let fulfillData: any = {}
    try {
      fulfillData = fulfillRaw ? JSON.parse(fulfillRaw) : {}
    } catch {
      fulfillData = { message: fulfillRaw.slice(0, 400) }
    }
    if (
      !fulfillRes.ok ||
      !Array.isArray(fulfillData?.qrcodes) ||
      !fulfillData.qrcodes.length
    ) {
      const errMsg = String(
        fulfillData?.message ||
          fulfillData?.error ||
          (fulfillRaw ? fulfillRaw.slice(0, 400) : `HTTP ${fulfillRes.status} 空回應`),
      )
      await patchMeta({
        fulfillment_status: "failed",
        fulfillment_error: errMsg.slice(0, 500),
      })
      throw new Error(`發貨失敗 HTTP ${fulfillRes.status}: ${errMsg}`)
    }

    await patchMeta({
      esim_qrcodes: JSON.stringify(
        fulfillData.qrcodes.map((q: any) => ({
          ...q,
          name: q?.name || "eSIM",
          src: normalizeQrSrc(q?.src),
        })),
      ),
      fulfillment_status: "fulfilled",
      fulfillment_error: "",
    })
    console.log(`[retry-fulfill] 發貨＋寄信完成，QR 數=${fulfillData.qrcodes.length}`)
  }

  // ── 開票 ──
  if (order.metadata?.ezpay_invoice_number) {
    console.log(
      `[retry-fulfill] 已有發票 ${order.metadata.ezpay_invoice_number}，略過開票`,
    )
  } else if (amount < 1) {
    console.warn("[retry-fulfill] amount < 1，略過開票")
  } else {
    const invoiceRes = await fetch(`${fulfillBase}/api/internal/issue-invoice`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        orderId: order.id,
        orderNo: orderNo.slice(0, 20),
        email: order.email,
        amount,
        items: lineItems.map((it) => ({
          name: it.name,
          qty: it.quantity || 1,
          price: it.unit_price ?? Math.round(amount / lineItems.length),
        })),
      }),
    })
    const invoiceData = await invoiceRes.json().catch(() => ({}))
    if (invoiceData?.skipped) {
      console.log(`[retry-fulfill] 開票略過: ${invoiceData.message}`)
    } else if (invoiceRes.ok && invoiceData?.success && invoiceData?.invoiceNumber) {
      await patchMeta({
        ezpay_invoice_number: invoiceData.invoiceNumber,
        ezpay_invoice_random: invoiceData.randomNum || "",
        ezpay_invoice_at: invoiceData.createTime || new Date().toISOString(),
      })
      console.log(`[retry-fulfill] 開票完成: ${invoiceData.invoiceNumber}`)
    } else {
      console.error(
        `[retry-fulfill] 開票失敗:`,
        invoiceData?.message || invoiceData,
      )
    }
  }

  console.log("[retry-fulfill] 完成。請重新整理 thank-you 頁。")
}
