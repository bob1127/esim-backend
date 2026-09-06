/**
 * 判斷是否為實體商品（充電線／配件等）。
 * 僅這類商品要隱藏 eSIM 電信商相關後台欄位。
 */
export function isPhysicalProduct(
  product: Record<string, any> | null | undefined,
): boolean {
  if (!product) return false;

  const meta = product.metadata || {};
  if (
    meta.is_physical === true ||
    meta.is_physical === "true" ||
    String(meta.product_kind || "").toLowerCase() === "physical" ||
    String(meta.shop_channel || "").toLowerCase() === "physical"
  ) {
    return true;
  }

  const typeValue = String(product.type?.value || product.type?.label || "");
  if (/實體/.test(typeValue) || /physical/i.test(typeValue)) {
    return true;
  }
  // 明確虛擬 → 不是實體
  if (/虛擬/.test(typeValue) || /virtual|digital|esim/i.test(typeValue)) {
    return false;
  }

  const categories = Array.isArray(product.categories) ? product.categories : [];
  for (const cat of categories) {
    if (categoryLooksPhysical(cat)) return true;
    const parent = cat?.parent_category || cat?.parent;
    if (parent && categoryLooksPhysical(parent)) return true;
  }

  const colHandle = String(product.collection?.handle || "").toLowerCase();
  const colTitle = String(product.collection?.title || "");
  if (
    ["physical", "accessories", "product"].includes(colHandle) ||
    /實體/.test(colTitle)
  ) {
    return true;
  }
  if (colHandle === "esim" || colTitle.toLowerCase().includes("esim")) {
    return false;
  }

  const blob = `${product.title || ""} ${product.handle || ""}`.toLowerCase();
  if (
    /anker|充電線|傳輸線|充電器|行動電源|cable|usb-?c|type-?c|編織線|配件|轉接|筆電包|電腦包|手提包|背包|收納/.test(
      blob,
    )
  ) {
    return true;
  }

  // 有顏色／尺寸選項、沒有電信商 → 實體配件
  if (hasColorOrSizeOption(product) && !hasTelecomOption(product)) {
    return true;
  }

  // 變體值像顏色（黑／白）、且沒電信商選項
  if (hasColorVariantValues(product) && !hasTelecomOption(product)) {
    return true;
  }

  return false;
}

/** eSIM 電信商相關 widget：實體商品一律不顯示 */
export function shouldShowEsimCarrierWidgets(
  product: Record<string, any> | null | undefined,
): boolean {
  if (!product) return true;
  if (isPhysicalProduct(product)) return false;
  return true;
}

function categoryLooksPhysical(cat: Record<string, any> | null | undefined) {
  if (!cat) return false;
  const handle = String(cat.handle || "").toLowerCase();
  const name = String(cat.name || "");
  return (
    handle === "physical" ||
    handle.startsWith("physical-") ||
    handle.startsWith("physical/") ||
    PHYSICAL_LEAF_HANDLES.has(handle) ||
    /實體/.test(name)
  );
}

const PHYSICAL_LEAF_HANDLES = new Set([
  "tech-accessories",
  "bags",
  "travel-gear",
  "pets-toys",
  "other",
]);

function optionTitleLooksTelecom(title: string) {
  const t = title.toLowerCase();
  return (
    t.includes("telecom") ||
    t.includes("電信") ||
    t.includes("carrier") ||
    t.includes("operator") ||
    t.includes("網路商")
  );
}

function optionTitleLooksColorOrSize(title: string) {
  const t = title.toLowerCase();
  return (
    t.includes("color") ||
    t.includes("colour") ||
    t.includes("顏色") ||
    t.includes("色") ||
    t.includes("size") ||
    t.includes("尺寸") ||
    t.includes("規格") ||
    t.includes("長度") ||
    t.includes("length")
  );
}

function hasTelecomOption(product: Record<string, any>) {
  const options = product.options || [];
  return options.some((opt: any) =>
    optionTitleLooksTelecom(String(opt?.title || "")),
  );
}

function hasColorOrSizeOption(product: Record<string, any>) {
  const options = product.options || [];
  return options.some((opt: any) =>
    optionTitleLooksColorOrSize(String(opt?.title || "")),
  );
}

function hasColorVariantValues(product: Record<string, any>) {
  const variants = product.variants || [];
  for (const v of variants) {
    for (const opt of v.options || []) {
      const val = String(opt?.value || "").trim();
      if (
        /^(黑|白|紅|藍|綠|灰|銀|金|粉|紫)(色)?$/i.test(val) ||
        /^(black|white|red|blue|green|gray|grey|silver|gold)$/i.test(val)
      ) {
        return true;
      }
    }
  }
  return false;
}
