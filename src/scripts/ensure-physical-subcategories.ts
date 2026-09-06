import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import {
  createProductCategoriesWorkflow,
  updateProductCategoriesWorkflow,
} from "@medusajs/core-flows"

/**
 * 實體商品子分類：掛到 physical 底下（Medusa 後台此版無父分類 UI）
 *
 *   npx medusa exec ./src/scripts/ensure-physical-subcategories.ts
 */

const PHYSICAL_HANDLE = "physical"

const CHILDREN = [
  {
    name: "3c、配件、周邊",
    handle: "tech-accessories",
    description: "3C、配件、周邊",
    rank: 0,
  },
  {
    name: "公事包、電腦包、休閒背包",
    handle: "bags",
    description: "公事包、電腦包、休閒背包",
    rank: 1,
  },
  {
    name: "旅遊周邊產品",
    handle: "travel-gear",
    description: "旅遊周邊產品",
    rank: 2,
  },
  {
    name: "寵物、玩具",
    handle: "pets-toys",
    description: "寵物、玩具",
    rank: 3,
  },
  {
    name: "其他",
    handle: "other",
    description: "其他",
    rank: 4,
  },
] as const

export default async function ensurePhysicalSubcategories({
  container,
}: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const productModule = container.resolve(Modules.PRODUCT)

  const existing = await productModule.listProductCategories(
    {},
    {
      take: 500,
      select: ["id", "name", "handle", "rank", "parent_category_id", "metadata"],
    },
  )

  const byHandle = new Map(
    existing.map((c) => [String(c.handle || "").toLowerCase(), c]),
  )

  const physical = byHandle.get(PHYSICAL_HANDLE)
  if (!physical) {
    throw new Error("找不到父分類 physical（實體商品），請先跑 nest-product-categories.ts")
  }

  for (const child of CHILDREN) {
    const found = byHandle.get(child.handle)
    if (found) {
      const meta = {
        ...((found.metadata as Record<string, unknown>) || {}),
        shop_channel: "physical",
      }
      await updateProductCategoriesWorkflow(container).run({
        input: {
          selector: { id: found.id },
          update: {
            parent_category_id: physical.id,
            rank: child.rank,
            name: child.name,
            description: child.description,
            metadata: meta,
          },
        },
      })
      logger.info(
        `已掛到實體商品：${child.name} (/${child.handle}) ← ${found.id}`,
      )
      continue
    }

    const { result } = await createProductCategoriesWorkflow(container).run({
      input: {
        product_categories: [
          {
            name: child.name,
            handle: child.handle,
            description: child.description,
            is_active: true,
            is_internal: false,
            parent_category_id: physical.id,
            rank: child.rank,
            metadata: { shop_channel: "physical" },
          },
        ],
      },
    })

    logger.info(
      `已建立並掛到實體商品：${child.name} (/${child.handle}) ← ${result[0]?.id}`,
    )
  }

  logger.info("完成：實體商品子分類已就緒")
}
