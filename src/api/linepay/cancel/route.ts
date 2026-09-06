import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { notifyLinePayCareFromOrderNo } from "../../../lib/notifyLinePayPaymentCare"

function resolveStoreUrl(): string {
  return (process.env.STORE_URL || "https://www.jeko-esim.com.tw").replace(
    /\/$/,
    "",
  )
}

/**
 * LINE Pay 取消／返回：寄未付款關懷信後導回購物車。
 * cancelUrl → GET /linepay/cancel?orderNo=C…
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const storeUrl = resolveStoreUrl()
  const q = (req.query || {}) as Record<string, string | string[] | undefined>
  const raw = q.orderNo
  const orderNo = String(Array.isArray(raw) ? raw[0] : raw || "").trim()

  if (orderNo) {
    try {
      const query = req.scope.resolve("query") as {
        graph: (args: Record<string, unknown>) => Promise<{ data: any[] }>
      }
      await notifyLinePayCareFromOrderNo({
        query,
        scope: req.scope,
        orderNo,
        reason: "linepay_cancel",
        message: "cancel",
      })
    } catch (e: any) {
      console.warn("[linepay-cancel] care email:", e?.message || e)
    }
  }

  return res.redirect(
    302,
    `${storeUrl}/Cart?linepay=cancel&step=1`,
  )
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  return GET(req, res)
}
