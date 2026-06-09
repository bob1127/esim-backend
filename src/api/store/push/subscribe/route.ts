import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { PUSH_MODULE } from "../../../../modules/push"
// 🌟 1. 引入你的 Service 型別 (路徑請確認是否正確)
import PushModuleService from "../../../../modules/push/service" 

export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
) {
  try {
    // 🌟 2. 加上型別斷言，告訴 TS 這個變數是 PushModuleService
    const pushModuleService = req.scope.resolve<PushModuleService>(PUSH_MODULE)
    
    // 接收從 Next.js 傳來的 JSON 資料
    const { endpoint, keys } = req.body as any

    if (!endpoint || !keys) {
      return res.status(400).json({ error: "缺少訂閱憑證資料" })
    }

    // 🌟 3. 確保傳入的是陣列 [{ ... }] (Medusa v2 的複數方法通常吃陣列)
    const subscription = await pushModuleService.createPushSubscriptions([{
      customer_id: null, // 如果你有實作登入，這裡可以改成 req.auth_context?.actor_id
      endpoint: endpoint,
      auth: keys.auth,
      p256dh: keys.p256dh,
    }])

    res.json({ success: true, subscription })
  } catch (error) {
    console.error("儲存訂閱憑證失敗:", error)
    res.status(500).json({ error: "Internal Server Error" })
  }
}