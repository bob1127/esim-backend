import { MedusaService } from "@medusajs/framework/utils"
import { PushSubscription } from "./models/push-subscription"

class PushModuleService extends MedusaService({
  PushSubscription,
}) {}

export default PushModuleService