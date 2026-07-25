import { ModuleProvider, Modules } from "@medusajs/framework/utils";
import NewebpayPaymentService from "./service";

export default ModuleProvider(Modules.PAYMENT, {
  services: [NewebpayPaymentService],
});
