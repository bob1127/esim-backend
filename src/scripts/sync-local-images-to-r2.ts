/**
 * 把「只存在本機 /static 的商品圖」上傳到 R2，並改寫資料庫 URL。
 *
 * 背景：本機 .env 沒有 S3_* 時，medusa-config 會退回 file-local，
 * 上傳的圖只存在這台電腦的 esim-backend/static/，DB 記的是
 * http://localhost:9000/static/xxx —— 正式站訪客抓不到，就是死圖。
 * 本機與正式站共用同一個 Supabase，所以商品資料本來就同步，缺的只有檔案。
 *
 * 用法（先看報告，再實際搬）：
 *   npx medusa exec ./src/scripts/sync-local-images-to-r2.ts
 *   npx medusa exec ./src/scripts/sync-local-images-to-r2.ts -- --apply
 *
 * 只處理實體商品：
 *   npx medusa exec ./src/scripts/sync-local-images-to-r2.ts -- --apply --physical-only
 *
 * --apply 需要本機 .env 具備 S3_ENDPOINT / S3_BUCKET / S3_FILE_URL /
 * S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY（與 Railway 相同一組），
 * 設好之後日後在 localhost:9000 上傳會直接進 R2，不必再跑這支。
 */
import fs from "fs"
import path from "path"
import { ExecArgs } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"

const STATIC_DIR = path.join(process.cwd(), "static")

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
}

/** 本機 static 的網址（DB 內只有這種需要搬） */
function isLocalStaticUrl(url: unknown): url is string {
  return (
    typeof url === "string" &&
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/static\//i.test(url.trim())
  )
}

function r2Configured(): boolean {
  return [
    "S3_ENDPOINT",
    "S3_BUCKET",
    "S3_FILE_URL",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
  ].every((k) => Boolean(process.env[k]?.trim()))
}

/**
 * 由 URL 找出本機實體檔案。
 * static/ 內有些檔名是中文被重複編碼過的亂碼，直接比對常常失敗，
 * 所以額外用檔名前面那段 timestamp（唯一）做備援比對。
 */
function makeLocalFileResolver() {
  const entries = fs.existsSync(STATIC_DIR) ? fs.readdirSync(STATIC_DIR) : []
  const byName = new Map<string, string>()
  const byTimestamp = new Map<string, string>()

  for (const name of entries) {
    byName.set(name, name)
    const ts = name.match(/^(\d{10,})-/)?.[1]
    if (ts && !byTimestamp.has(ts)) byTimestamp.set(ts, name)
  }

  return (url: string): string | null => {
    const raw = url.trim().split(/[?#]/)[0]
    const tail = raw.replace(/^.*\/static\//i, "")
    const candidates = [tail]
    try {
      candidates.push(decodeURIComponent(tail))
    } catch {
      /* URL 本來就不是編碼過的 */
    }

    for (const candidate of candidates) {
      if (byName.has(candidate)) {
        return path.join(STATIC_DIR, byName.get(candidate)!)
      }
    }

    const ts = candidates
      .map((c) => c.match(/^(\d{10,})-/)?.[1])
      .find(Boolean)
    if (ts && byTimestamp.has(ts)) {
      return path.join(STATIC_DIR, byTimestamp.get(ts)!)
    }
    return null
  }
}

/** 遞迴改寫任意 metadata 結構內的網址（physical_description.images 等都吃得到） */
function rewriteDeep(
  value: unknown,
  mapUrl: (url: string) => string | null
): { value: unknown; changed: number } {
  if (isLocalStaticUrl(value)) {
    const next = mapUrl(value)
    return next ? { value: next, changed: 1 } : { value, changed: 0 }
  }
  if (Array.isArray(value)) {
    let changed = 0
    const arr = value.map((item) => {
      const r = rewriteDeep(item, mapUrl)
      changed += r.changed
      return r.value
    })
    return { value: changed ? arr : value, changed }
  }
  if (value && typeof value === "object") {
    let changed = 0
    const obj: Record<string, unknown> = {
      ...(value as Record<string, unknown>),
    }
    for (const [k, v] of Object.entries(obj)) {
      const r = rewriteDeep(v, mapUrl)
      changed += r.changed
      obj[k] = r.value
    }
    return { value: changed ? obj : value, changed }
  }
  return { value, changed: 0 }
}

function looksEsim(product: any): boolean {
  const hay = [product?.type?.value, product?.title, product?.handle]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
  return /esim|sim卡|上網卡|網卡/.test(hay)
}

export default async function syncLocalImagesToR2({ container, args }: ExecArgs) {
  // Medusa exec 有時不把 `--` 後參數塞進 args，一併看 process.argv
  const flags = [...(args || []), ...process.argv.slice(2)]
  const apply = flags.includes("--apply")
  const physicalOnly = flags.includes("--physical-only")
  console.log(`[flags] apply=${apply} physicalOnly=${physicalOnly} argv=${JSON.stringify(flags)}`)

  const query = container.resolve("query") as any
  const productModule = container.resolve(Modules.PRODUCT) as any
  const fileModule = container.resolve(Modules.FILE) as any

  const resolveLocalFile = makeLocalFileResolver()

  /**
   * Supabase 有 statement timeout：一次把 images／categories／variants 全 join
   * 會產生笛卡兒積而超時。拆成三個小查詢並分頁。
   */
  const PAGE = 50
  const pageAll = async (entity: string, fields: string[]) => {
    const rows: any[] = []
    for (let skip = 0; ; skip += PAGE) {
      const { data } = await query.graph({
        entity,
        fields,
        filters: {},
        pagination: { skip, take: PAGE },
      })
      if (!data?.length) break
      rows.push(...data)
      if (data.length < PAGE) break
    }
    return rows
  }

  const baseRows = await pageAll("product", [
    "id",
    "handle",
    "title",
    "thumbnail",
    "metadata",
    "type.value",
  ])
  const imageRows = await pageAll("product", [
    "id",
    "images.id",
    "images.url",
    "images.rank",
  ])
  const variantRows = await pageAll("product_variant", [
    "id",
    "product_id",
    "metadata",
  ])

  const imagesByProduct = new Map<string, any[]>()
  for (const row of imageRows) {
    if (row?.id) imagesByProduct.set(row.id, row.images || [])
  }
  const variantsByProduct = new Map<string, any[]>()
  for (const v of variantRows) {
    if (!v?.product_id) continue
    const list = variantsByProduct.get(v.product_id) || []
    list.push(v)
    variantsByProduct.set(v.product_id, list)
  }

  const products = baseRows.map((p) => ({
    ...p,
    images: imagesByProduct.get(p.id) || [],
    variants: variantsByProduct.get(p.id) || [],
  }))

  type Target = {
    product: any
    urls: Set<string>
  }
  const targets: Target[] = []
  const allUrls = new Set<string>()

  for (const product of products || []) {
    if (physicalOnly && looksEsim(product)) continue

    const urls = new Set<string>()
    const collect = (v: unknown) => {
      rewriteDeep(v, (url) => {
        urls.add(url)
        return null
      })
    }
    if (isLocalStaticUrl(product.thumbnail)) urls.add(product.thumbnail)
    for (const img of product.images || []) {
      if (isLocalStaticUrl(img?.url)) urls.add(img.url)
    }
    collect(product.metadata)
    for (const v of product.variants || []) collect(v?.metadata)

    if (urls.size) {
      targets.push({ product, urls })
      for (const u of urls) allUrls.add(u)
    }
  }

  const missing: string[] = []
  const found: string[] = []
  for (const url of allUrls) {
    ;(resolveLocalFile(url) ? found : missing).push(url)
  }

  console.log("──────── 本機 static 圖片盤點 ────────")
  console.log(`掃過商品：${products?.length ?? 0} 筆${physicalOnly ? "（已排除 eSIM）" : ""}`)
  console.log(`有 localhost 圖的商品：${targets.length} 筆`)
  console.log(`需搬移的圖片網址：${allUrls.size} 個`)
  console.log(`  ├─ 本機找得到檔案：${found.length}`)
  console.log(`  └─ 本機也找不到（需重新上傳）：${missing.length}`)

  if (targets.length) {
    console.log("\n受影響商品（最多列 20 筆）：")
    for (const t of targets.slice(0, 20)) {
      console.log(`  - ${t.product.handle || t.product.id}（${t.urls.size} 張）`)
    }
  }
  if (missing.length) {
    console.log("\n找不到本機檔案的網址（最多列 10 個）：")
    for (const u of missing.slice(0, 10)) console.log(`  ! ${u}`)
  }

  if (!apply) {
    console.log(
      "\n目前為唯讀盤點。要實際上傳並改寫 DB，請加 -- --apply（需先設好 S3_* 環境變數）。"
    )
    return
  }

  if (!r2Configured()) {
    throw new Error(
      "缺少 R2 設定，無法上傳。請把 Railway 上那組 S3_ENDPOINT / S3_BUCKET / S3_FILE_URL / " +
        "S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY 複製到 esim-backend/.env 後重跑。"
    )
  }

  // 1) 上傳檔案（同一個檔只上傳一次）
  const urlMap = new Map<string, string>()
  let uploaded = 0
  for (const url of found) {
    const filePath = resolveLocalFile(url)!
    const ext = path.extname(filePath).toLowerCase()
    try {
      const content = fs.readFileSync(filePath).toString("base64")
      const [file] = await fileModule.createFiles([
        {
          filename: path.basename(filePath),
          mimeType: MIME_BY_EXT[ext] || "application/octet-stream",
          content,
        },
      ])
      if (!file?.url) throw new Error("上傳成功但沒拿到網址")
      urlMap.set(url, file.url)
      uploaded++
      console.log(`[上傳] ${path.basename(filePath)} → ${file.url}`)
    } catch (e: any) {
      console.error(`[上傳失敗] ${filePath}: ${e?.message || e}`)
    }
  }

  // 2) 改寫 DB
  let productsUpdated = 0
  let variantsUpdated = 0
  const mapUrl = (url: string) => urlMap.get(url) || null

  for (const { product } of targets) {
    const update: Record<string, unknown> = { id: product.id }
    let dirty = false

    if (isLocalStaticUrl(product.thumbnail) && urlMap.has(product.thumbnail)) {
      update.thumbnail = urlMap.get(product.thumbnail)
      dirty = true
    }

    const images = [...(product.images || [])].sort(
      (a: any, b: any) => Number(a?.rank ?? 0) - Number(b?.rank ?? 0)
    )
    if (images.some((img: any) => urlMap.has(img?.url))) {
      // 帶 id → 就地改 URL；不帶 id 會整批重建
      update.images = images.map((img: any) => ({
        ...(img?.id ? { id: img.id } : {}),
        url: urlMap.get(img?.url) || img?.url,
      }))
      dirty = true
    }

    const meta = rewriteDeep(product.metadata, mapUrl)
    if (meta.changed > 0) {
      update.metadata = meta.value
      dirty = true
    }

    if (dirty) {
      const { id, ...data } = update as { id: string } & Record<string, unknown>
      await productModule.updateProducts(id, data)
      productsUpdated++
      console.log(`[改寫] ${product.handle || product.id}`)
    }

    for (const variant of product.variants || []) {
      const vMeta = rewriteDeep(variant?.metadata, mapUrl)
      if (vMeta.changed > 0) {
        await productModule.updateProductVariants(variant.id, {
          metadata: vMeta.value as Record<string, unknown>,
        })
        variantsUpdated++
      }
    }
  }

  console.log("\n──────── 完成 ────────")
  console.log(`已上傳檔案：${uploaded} / ${found.length}`)
  console.log(`已更新商品：${productsUpdated} 筆，變體：${variantsUpdated} 筆`)
  if (missing.length) {
    console.log(
      `仍有 ${missing.length} 個網址在本機找不到檔案，需要在後台重新上傳那幾張圖。`
    )
  }
  console.log(
    "日後在 localhost:9000 上傳會直接進 R2（因為 .env 已有 S3_*），不需再跑這支。"
  )
}
