import { Module } from "@medusajs/framework/utils"
import PushModuleService from "./service"

export const PUSH_MODULE = "push"

export default Module(PUSH_MODULE, {
  service: PushModuleService,
})