import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

/**
 * 批次掛商品類型（扁平：虛擬商品 / 實體產品）
 *
 *   npx medusa exec ./src/scripts/assign-product-types.ts
 *
 * 不走 Admin HTTP（商品變體多時 refetch 會 statement timeout）
 */
export default async function assignProductTypes({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const productModule = container.resolve(Modules.PRODUCT)

  const types = await productModule.listProductTypes({}, { take: 50 })
  const virtual = types.find((t) => /虛擬/.test(String(t.value || "")))
  const physical = types.find((t) =>
    /實體/.test(String(t.value || "")),
  )

  if (!virtual) throw new Error("找不到商品類型「虛擬商品」")
  if (!physical) throw new Error("找不到商品類型「實體產品／實體商品」")

  logger.info(`虛擬類型: ${virtual.value} (${virtual.id})`)
  logger.info(`實體類型: ${physical.value} (${physical.id})`)

  const products = await productModule.listProducts(
    {},
    {
      take: 500,
      select: ["id", "title", "handle", "type_id", "collection_id"],
      relations: ["collection"],
    },
  )

  let nVirtual = 0
  let nPhysical = 0
  let nSkip = 0
  let nAlready = 0

  const updates: { id: string; type_id: string }[] = []

  for (const p of products) {
    const colHandle = String(
      (p as { collection?: { handle?: string; title?: string } }).collection
        ?.handle || "",
    ).toLowerCase()
    const colTitle = String(
      (p as { collection?: { handle?: string; title?: string } }).collection
        ?.title || "",
    ).toLowerCase()
    const handle = String(p.handle || "").toLowerCase()
    const title = String(p.title || "").toLowerCase()
    const blob = `${colHandle} ${colTitle} ${handle} ${title}`

    let targetId: string | null = null
    let kind = ""

    if (
      colHandle === "esim" ||
      colTitle.includes("esim") ||
      handle.includes("esim") ||
      title.includes("esim") ||
      /吃到飽|總量型|每日型/.test(title)
    ) {
      targetId = virtual.id
      kind = "虛擬"
    } else if (
      ["physical", "accessories", "product"].includes(colHandle) ||
      /實體/.test(colTitle) ||
      /usb|cable|線|轉接|配件|charger|充電/.test(blob)
    ) {
      targetId = physical.id
      kind = "實體"
    } else if (/-(unlimited|daily|total)/i.test(handle)) {
      targetId = virtual.id
      kind = "虛擬"
    } else {
      nSkip++
      logger.info(`略過: ${p.title} [${p.handle}]`)
      continue
    }

    if (p.type_id === targetId) {
      nAlready++
      continue
    }

    updates.push({ id: p.id, type_id: targetId })
    if (kind === "虛擬") nVirtual++
    else nPhysical++
    logger.info(`${kind}: ${p.title}`)
  }

  // 逐筆更新（模組 updateProducts 批次陣列在此版會報 Product.0）
  let done = 0
  for (const u of updates) {
    await productModule.updateProducts(u.id, { type_id: u.type_id })
    done++
    if (done % 10 === 0 || done === updates.length) {
      logger.info(`已寫入 ${done} / ${updates.length}`)
    }
  }

  logger.info(
    `完成：虛擬 ${nVirtual}、實體 ${nPhysical}、已正確 ${nAlready}、略過 ${nSkip}`,
  )
}
