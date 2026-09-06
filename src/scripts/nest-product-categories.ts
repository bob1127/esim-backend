import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import {
  createProductCategoriesWorkflow,
  updateProductCategoriesWorkflow,
} from "@medusajs/core-flows"

/**
 * 將國家分類掛成兩層：eSIM / 實體商品（頂層）→ 國家（子層）
 *
 *   npx medusa exec ./src/scripts/nest-product-categories.ts
 *
 * 可重跑：已存在的父層會沿用；已掛在父層下的子分類會略過。
 * metadata.nav_group=true → 前台虛擬商品選單排除父層。
 */

const PARENTS = [
  {
    name: "eSIM",
    handle: "esim",
    description: "虛擬 eSIM 國家分類（後台整理用）",
    rank: 0,
  },
  {
    name: "實體商品",
    handle: "physical",
    description: "實體配件等（後台整理用，前台暫不顯示）",
    rank: 1,
  },
] as const

const PARENT_HANDLES = new Set(PARENTS.map((p) => p.handle))

export default async function nestProductCategories({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const productModule = container.resolve(Modules.PRODUCT)

  const existing = await productModule.listProductCategories(
    {},
    {
      take: 500,
      select: [
        "id",
        "name",
        "handle",
        "rank",
        "parent_category_id",
        "metadata",
      ],
    },
  )

  const byHandle = new Map(
    existing.map((c) => [String(c.handle || "").toLowerCase(), c]),
  )

  const parentIds: Record<string, string> = {}

  for (const parent of PARENTS) {
    const found = byHandle.get(parent.handle)
    if (found) {
      parentIds[parent.handle] = found.id
      const meta = {
        ...((found.metadata as Record<string, unknown>) || {}),
        nav_group: true,
      }
      await updateProductCategoriesWorkflow(container).run({
        input: {
          selector: { id: found.id },
          update: {
            parent_category_id: null,
            rank: parent.rank,
            metadata: meta,
            description: parent.description,
          },
        },
      })
      logger.info(`沿用父分類 ${parent.name} (${found.id})`)
      continue
    }

    const { result } = await createProductCategoriesWorkflow(container).run({
      input: {
        product_categories: [
          {
            name: parent.name,
            handle: parent.handle,
            description: parent.description,
            is_active: true,
            is_internal: false,
            rank: parent.rank,
            metadata: { nav_group: true },
          },
        ],
      },
    })

    const created = result[0]
    parentIds[parent.handle] = created.id
    byHandle.set(parent.handle, created as (typeof existing)[0])
    logger.info(`建立父分類 ${parent.name} (${created.id})`)
  }

  const esimParentId = parentIds.esim
  if (!esimParentId) throw new Error("缺少 eSIM 父分類")

  let moved = 0
  let skipped = 0

  for (const cat of existing) {
    const handle = String(cat.handle || "").toLowerCase()
    if (PARENT_HANDLES.has(handle)) {
      skipped += 1
      continue
    }
    if (cat.parent_category_id === esimParentId) {
      skipped += 1
      continue
    }
    // 已掛在其他父層（例如之後手動掛到實體商品）則不強制搬
    if (cat.parent_category_id) {
      logger.info(
        `略過已有父層：${cat.name} (/${handle}) → ${cat.parent_category_id}`,
      )
      skipped += 1
      continue
    }

    await updateProductCategoriesWorkflow(container).run({
      input: {
        selector: { id: cat.id },
        update: {
          parent_category_id: esimParentId,
          rank: cat.rank ?? 0,
        },
      },
    })
    moved += 1
    logger.info(`掛到 eSIM：${cat.name} (/${handle})`)
  }

  logger.info(
    `完成：moved=${moved}, skipped=${skipped}, parents=${Object.keys(parentIds).join(",")}`,
  )
}
