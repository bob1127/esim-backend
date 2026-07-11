import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { updateProductCategoriesWorkflow } from "@medusajs/core-flows";

type ReorderBody = {
  items?: { id: string; rank: number }[];
};

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const body = (req.body || {}) as ReorderBody;
  const items = body.items;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "items 不可為空" });
  }

  try {
    for (const item of items) {
      if (!item?.id || typeof item.rank !== "number" || item.rank < 0) {
        continue;
      }

      await updateProductCategoriesWorkflow(req.scope).run({
        input: {
          selector: { id: item.id },
          update: { rank: item.rank },
        },
      });
    }

    return res.status(200).json({ success: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[admin/product-categories/reorder]", message);
    return res.status(500).json({ error: "排序更新失敗", detail: message });
  }
}
