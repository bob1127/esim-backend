import React, { useCallback, useEffect, useState } from "react";
import { defineWidgetConfig } from "@medusajs/admin-sdk";
import { DotsSix, Spinner } from "@medusajs/icons";
import {
  Badge,
  Container,
  Heading,
  Text,
  clx,
  toast,
} from "@medusajs/ui";

type CategoryItem = {
  id: string;
  name: string;
  handle: string;
  rank: number;
};

const reorder = <T,>(list: T[], from: number, to: number) => {
  const next = [...list];
  const [removed] = next.splice(from, 1);
  next.splice(to, 0, removed);
  return next;
};

const CategoryRankSortWidget = () => {
  const [items, setItems] = useState<CategoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  const loadCategories = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(
        "/admin/product-categories?parent_category_id=null&limit=100&fields=id,name,handle,rank",
        { credentials: "include" },
      );

      if (!response.ok) {
        throw new Error("無法載入分類");
      }

      const data = await response.json();
      const categories = (data.product_categories || []) as CategoryItem[];

      setItems(
        [...categories].sort((a, b) => {
          const rankDiff = (a.rank ?? 0) - (b.rank ?? 0);
          if (rankDiff !== 0) return rankDiff;
          return a.name.localeCompare(b.name, "zh-TW");
        }),
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "載入失敗";
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCategories();
  }, [loadCategories]);

  const saveOrder = async (ordered: CategoryItem[]) => {
    setSaving(true);
    try {
      const response = await fetch("/admin/product-categories/reorder", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: ordered.map((cat, index) => ({ id: cat.id, rank: index })),
        }),
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || errData.detail || "儲存失敗");
      }

      toast.success("分類順序已更新，前台將依此排序顯示");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "儲存失敗";
      toast.error(message);
      await loadCategories();
    } finally {
      setSaving(false);
    }
  };

  const handleDrop = async (dropIndex: number) => {
    if (dragIndex === null || dragIndex === dropIndex) {
      setDragIndex(null);
      setOverIndex(null);
      return;
    }

    const next = reorder(items, dragIndex, dropIndex).map((cat, index) => ({
      ...cat,
      rank: index,
    }));

    setItems(next);
    setDragIndex(null);
    setOverIndex(null);
    await saveOrder(next);
  };

  if (loading) {
    return (
      <Container className="mb-4 flex items-center gap-2 px-6 py-4">
        <Spinner className="animate-spin text-ui-fg-muted" />
        <Text size="small" className="text-ui-fg-subtle">
          載入分類排序...
        </Text>
      </Container>
    );
  }

  if (items.length === 0) {
    return null;
  }

  return (
    <Container className="mb-4 divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <div>
          <Heading level="h2">拖拉調整分類順序</Heading>
          <Text size="small" className="text-ui-fg-subtle mt-1">
            按住左側圖示拖拉，順序會同步至前台導覽列與首頁國家選單。
          </Text>
        </div>
        {saving && (
          <Badge color="blue" size="small">
            儲存中...
          </Badge>
        )}
      </div>

      <ul className="px-3 py-2">
        {items.map((cat, index) => {
          const isDragging = dragIndex === index;
          const isOver = overIndex === index && dragIndex !== index;

          return (
            <li
              key={cat.id}
              draggable={!saving}
              onDragStart={() => setDragIndex(index)}
              onDragEnd={() => {
                setDragIndex(null);
                setOverIndex(null);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                if (dragIndex !== null && dragIndex !== index) {
                  setOverIndex(index);
                }
              }}
              onDrop={(event) => {
                event.preventDefault();
                void handleDrop(index);
              }}
              className={clx(
                "mb-1 flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors",
                {
                  "border-ui-border-base bg-ui-bg-base cursor-grab active:cursor-grabbing":
                    !saving,
                  "border-ui-border-strong bg-ui-bg-subtle opacity-60": isDragging,
                  "border-ui-border-interactive bg-ui-bg-subtle-hover": isOver,
                  "pointer-events-none opacity-70": saving,
                },
              )}
            >
              <span className="text-ui-fg-muted flex shrink-0 items-center">
                <DotsSix />
              </span>
              <span className="text-ui-fg-subtle w-6 shrink-0 text-sm">
                {index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <Text size="small" weight="plus" className="truncate">
                  {cat.name}
                </Text>
                <Text size="xsmall" className="text-ui-fg-muted truncate">
                  /{cat.handle}
                </Text>
              </div>
            </li>
          );
        })}
      </ul>
    </Container>
  );
};

export const config = defineWidgetConfig({
  zone: "product_category.list.before",
});

export default CategoryRankSortWidget;
