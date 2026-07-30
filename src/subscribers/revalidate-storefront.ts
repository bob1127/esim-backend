import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"

type ProductLike = {
  id?: string
  handle?: string | null
  categories?: Array<{ handle?: string | null } | null> | null
}

function getStorefrontBase(): string {
  return (
    process.env.STOREFRONT_REVALIDATE_URL ||
    process.env.FULFILLMENT_INTERNAL_URL ||
    process.env.STORE_URL ||
    ""
  )
    .trim()
    .replace(/\/$/, "")
}

function getSecret(): string {
  return (
    process.env.REVALIDATE_SECRET ||
    process.env.FULFILLMENT_INTERNAL_SECRET ||
    ""
  )
}

function withSlash(path: string): string {
  return path.endsWith("/") ? path : `${path}/`
}

/** 前台 ISR 路徑（trailingSlash: true） */
export function buildProductRevalidatePaths(product: ProductLike): string[] {
  const paths = new Set<string>([withSlash("/product")])
  const handle = (product.handle || "").trim()
  const categories = (product.categories || [])
    .map((c) => (c?.handle || "").trim())
    .filter(Boolean)

  const categoryHandles = categories.length ? categories : ["uncategorized"]

  for (const cat of categoryHandles) {
    paths.add(withSlash(`/product/${cat}`))
    if (handle) {
      paths.add(withSlash(`/product/${cat}/${handle}`))
    }
  }

  return [...paths]
}

async function postRevalidate(paths: string[], reason: string) {
  const base = getStorefrontBase()
  const secret = getSecret()

  if (!base) {
    console.warn(
      `[revalidate-storefront] 略過（${reason}）：未設定 STORE_URL / FULFILLMENT_INTERNAL_URL`,
    )
    return
  }
  if (!secret || secret.length < 16) {
    console.warn(
      `[revalidate-storefront] 略過（${reason}）：未設定 REVALIDATE_SECRET / FULFILLMENT_INTERNAL_SECRET`,
    )
    return
  }

  const unique = [...new Set(paths.map(withSlash))]
  if (!unique.length) return

  try {
    const res = await fetch(`${base}/api/revalidate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Revalidate-Secret": secret,
      },
      body: JSON.stringify({ paths: unique }),
    })
    const text = await res.text()
    if (!res.ok) {
      console.error(
        `[revalidate-storefront] HTTP ${res.status}（${reason}）:`,
        text.slice(0, 500),
      )
      return
    }
    console.log(
      `[revalidate-storefront] ok（${reason}）paths=${unique.join(", ")}`,
    )
  } catch (err: any) {
    console.error(
      `[revalidate-storefront] fetch failed（${reason}）:`,
      err?.message || err,
    )
  }
}

async function loadProduct(
  container: SubscriberArgs["container"],
  productId: string,
): Promise<ProductLike | null> {
  try {
    const productModule = container.resolve("product") as {
      retrieveProduct: (
        id: string,
        config?: { relations?: string[] },
      ) => Promise<ProductLike>
    }
    return await productModule.retrieveProduct(productId, {
      relations: ["categories"],
    })
  } catch (err: any) {
    console.warn(
      `[revalidate-storefront] retrieveProduct(${productId}) failed:`,
      err?.message || err,
    )
    return null
  }
}

export default async function revalidateStorefrontHandler({
  event,
  container,
}: SubscriberArgs<{ id: string; product_id?: string }>) {
  const name = event.name
  const data = event.data || ({} as { id: string; product_id?: string })

  // 商品刪除：多半已查不到詳情 → 至少清列表
  if (name === "product.deleted") {
    await postRevalidate([withSlash("/product")], `product.deleted:${data.id}`)
    return
  }

  // 分類變更：清總列表 + 該分類列表
  if (
    name === "product-category.created" ||
    name === "product-category.updated" ||
    name === "product-category.deleted"
  ) {
    const paths = [withSlash("/product")]
    try {
      const productModule = container.resolve("product") as {
        retrieveProductCategory?: (
          id: string,
        ) => Promise<{ handle?: string | null }>
      }
      if (
        name !== "product-category.deleted" &&
        typeof productModule.retrieveProductCategory === "function"
      ) {
        const cat = await productModule.retrieveProductCategory(data.id)
        if (cat?.handle) {
          paths.push(withSlash(`/product/${cat.handle}`))
        }
      }
    } catch {
      /* ignore */
    }
    await postRevalidate(paths, `${name}:${data.id}`)
    return
  }

  // variant 事件 → 找 parent product
  let productId = data.id
  if (String(name).startsWith("product-variant.")) {
    productId = data.product_id || ""
    if (!productId) {
      try {
        const productModule = container.resolve("product") as {
          retrieveProductVariant: (
            id: string,
            config?: { relations?: string[] },
          ) => Promise<{ product_id?: string; product?: ProductLike }>
        }
        const variant = await productModule.retrieveProductVariant(data.id, {
          relations: ["product", "product.categories"],
        })
        productId = variant.product_id || variant.product?.id || ""
        if (variant.product?.handle) {
          await postRevalidate(
            buildProductRevalidatePaths(variant.product),
            `${name}:${data.id}`,
          )
          return
        }
      } catch (err: any) {
        console.warn(
          `[revalidate-storefront] variant resolve failed:`,
          err?.message || err,
        )
      }
    }
  }

  if (!productId) {
    await postRevalidate([withSlash("/product")], `${name}:fallback-list`)
    return
  }

  const product = await loadProduct(container, productId)
  if (!product) {
    await postRevalidate(
      [withSlash("/product")],
      `${name}:${productId}:list-only`,
    )
    return
  }

  await postRevalidate(
    buildProductRevalidatePaths(product),
    `${name}:${productId}`,
  )
}

export const config: SubscriberConfig = {
  event: [
    "product.created",
    "product.updated",
    "product.deleted",
    "product-variant.created",
    "product-variant.updated",
    "product-variant.deleted",
    "product-category.created",
    "product-category.updated",
    "product-category.deleted",
  ],
}
