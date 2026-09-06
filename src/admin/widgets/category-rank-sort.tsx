import React, { useCallback, useEffect, useMemo, useState } from "react";
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
  parent_category_id: string | null;
};

type SortGroup = {
  key: string;
  title: string;
  subtitle: string;
  parentId: string | null;
  items: CategoryItem[];
};

const reorder = <T,>(list: T[], from: number, to: number) => {
  const next = [...list];
  const [removed] = next.splice(from, 1);
  next.splice(to, 0, removed);
  return next;
};

const sortByRank = (categories: CategoryItem[]) =>
  [...categories].sort((a, b) => {
    const rankDiff = (a.rank ?? 0) - (b.rank ?? 0);
    if (rankDiff !== 0) return rankDiff;
    return a.name.localeCompare(b.name, "zh-TW");
  });

const CategoryRankSortWidget = () => {
  const [allItems, setAllItems] = useState<CategoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  const loadCategories = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(
        "/admin/product-categories?limit=200&fields=id,name,handle,rank,parent_category_id",
        { credentials: "include" },
      );

      if (!response.ok) {
        throw new Error("無法載入分類");
      }

      const data = await response.json();
      const categories = (data.product_categories || []) as CategoryItem[];
      setAllItems(
        categories.map((cat) => ({
          ...cat,
          parent_category_id: cat.parent_category_id ?? null,
          rank: cat.rank ?? 0,
        })),
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

  const groups: SortGroup[] = useMemo(() => {
    const byId = new Map(allItems.map((c) => [c.id, c]));
    const roots = sortByRank(
      allItems.filter((c) => !c.parent_category_id),
    );

    const result: SortGroup[] = [
      {
        key: "root",
        title: "頂層分類",
        subtitle: "例如 eSIM、實體商品（僅後台整理用，前台不顯示）",
        parentId: null,
        items: roots,
      },
    ];

    for (const root of roots) {
      const children = sortByRank(
        allItems.filter((c) => c.parent_category_id === root.id),
      );
      if (children.length === 0 && !byId.has(root.id)) continue;
      result.push({
        key: root.id,
        title: `${root.name} 底下`,
        subtitle: `/${root.handle} — 拖拉調整同層順序（前台國家選單依此排序）`,
        parentId: root.id,
        items: children,
      });
    }

    return result;
  }, [allItems]);

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

      toast.success("分類順序已更新");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "儲存失敗";
      toast.error(message);
      await loadCategories();
    } finally {
      setSaving(false);
    }
  };

  const handleDrop = async (groupKey: string, dropIndex: number) => {
    if (
      dragKey === null ||
      dragIndex === null ||
      dragKey !== groupKey ||
      dragIndex === dropIndex
    ) {
      setDragKey(null);
      setDragIndex(null);
      setOverKey(null);
      setOverIndex(null);
      return;
    }

    const group = groups.find((g) => g.key === groupKey);
    if (!group) return;

    const nextGroupItems = reorder(group.items, dragIndex, dropIndex).map(
      (cat, index) => ({
        ...cat,
        rank: index,
      }),
    );

    setAllItems((prev) => {
      const nextIds = new Set(nextGroupItems.map((c) => c.id));
      return [
        ...prev.filter((c) => !nextIds.has(c.id)),
        ...nextGroupItems,
      ];
    });

    setDragKey(null);
    setDragIndex(null);
    setOverKey(null);
    setOverIndex(null);
    await saveOrder(nextGroupItems);
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

  if (allItems.length === 0) {
    return null;
  }

  return (
    <Container className="mb-4 divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <div>
          <Heading level="h2">拖拉調整分類順序</Heading>
          <Text size="small" className="text-ui-fg-subtle mt-1">
            兩層結構：僅能在「同層」內拖拉。國家順序會同步前台導覽；頂層父分類不會出現在虛擬商品選單。
          </Text>
        </div>
        {saving && (
          <Badge color="blue" size="small">
            儲存中...
          </Badge>
        )}
      </div>

      {groups.map((group) => (
        <div key={group.key} className="px-3 py-3">
          <div className="mb-2 px-3">
            <Text size="small" weight="plus">
              {group.title}
            </Text>
            <Text size="xsmall" className="text-ui-fg-muted">
              {group.subtitle}
            </Text>
          </div>

          {group.items.length === 0 ? (
            <Text size="small" className="text-ui-fg-muted px-3 py-2">
              （尚無子分類）
            </Text>
          ) : (
            <ul>
              {group.items.map((cat, index) => {
                const isDragging =
                  dragKey === group.key && dragIndex === index;
                const isOver =
                  overKey === group.key &&
                  overIndex === index &&
                  !(dragKey === group.key && dragIndex === index);

                return (
                  <li
                    key={cat.id}
                    draggable={!saving}
                    onDragStart={() => {
                      setDragKey(group.key);
                      setDragIndex(index);
                    }}
                    onDragEnd={() => {
                      setDragKey(null);
                      setDragIndex(null);
                      setOverKey(null);
                      setOverIndex(null);
                    }}
                    onDragOver={(event) => {
                      event.preventDefault();
                      if (dragKey === group.key && dragIndex !== index) {
                        setOverKey(group.key);
                        setOverIndex(index);
                      }
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      void handleDrop(group.key, index);
                    }}
                    className={clx(
                      "mb-1 flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors",
                      {
                        "border-ui-border-base bg-ui-bg-base cursor-grab active:cursor-grabbing":
                          !saving,
                        "border-ui-border-strong bg-ui-bg-subtle opacity-60":
                          isDragging,
                        "border-ui-border-interactive bg-ui-bg-subtle-hover":
                          isOver,
                        "pointer-events-none opacity-70": saving,
                        "ml-4": group.parentId != null,
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
          )}
        </div>
      ))}
    </Container>
  );
};

export const config = defineWidgetConfig({
  zone: "product_category.list.before",
});

export default CategoryRankSortWidget;
