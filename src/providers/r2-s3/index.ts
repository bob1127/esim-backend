import { ModuleProvider, Modules } from "@medusajs/framework/utils"
import { R2S3FileService } from "./service"

export default ModuleProvider(Modules.FILE, {
  services: [R2S3FileService],
})
