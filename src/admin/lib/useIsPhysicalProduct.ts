import { useEffect, useState } from "react";
import {
  isPhysicalProduct,
  shouldShowEsimCarrierWidgets,
} from "./isPhysicalProduct";

/**
 * 商品詳情 widget 用：同步判斷 + 必要時補抓 type／categories／options。
 * 確認為實體後隱藏 eSIM 電信商欄位。
 */
export function useIsPhysicalProduct(
  product: Record<string, any> | null | undefined,
): boolean {
  const [isPhysical, setIsPhysical] = useState(() =>
    isPhysicalProduct(product),
  );

  useEffect(() => {
    let cancelled = false;

    if (isPhysicalProduct(product)) {
      setIsPhysical(true);
      return;
    }

    const id = product?.id;
    if (!id) {
      setIsPhysical(false);
      return;
    }

    ;(async () => {
      try {
        const res = await fetch(
          `/admin/products/${encodeURIComponent(id)}?fields=id,title,handle,metadata,*type,*categories,*collection,*options,*variants,*variants.options`,
          { credentials: "include" },
        );
        if (!res.ok || cancelled) return;
        const json = await res.json();
        const enriched = {
          ...(product || {}),
          ...(json.product || json),
        };
        if (!cancelled) setIsPhysical(isPhysicalProduct(enriched));
      } catch {
        if (!cancelled) setIsPhysical(isPhysicalProduct(product));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [product?.id]);

  return isPhysical;
}

/** true = 顯示電信商相關 widget；實體商品為 false */
export function useShowEsimCarrierWidgets(
  product: Record<string, any> | null | undefined,
): boolean {
  const isPhysical = useIsPhysicalProduct(product);
  if (isPhysical) return false;
  return shouldShowEsimCarrierWidgets(product);
}
