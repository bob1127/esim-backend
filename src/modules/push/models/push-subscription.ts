import { model } from "@medusajs/framework/utils"

export const PushSubscription = model.define("push_subscription", {
  id: model.id().primaryKey(),
  customer_id: model.text().nullable(), // 如果是會員就記錄 ID，訪客則為 null
  endpoint: model.text(),               // 瀏覽器推播的專屬網址
  auth: model.text(),                   // 加密金鑰 auth
  p256dh: model.text(),                 // 加密金鑰 p256dh
})