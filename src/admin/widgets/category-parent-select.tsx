import React, { useCallback, useEffect, useMemo, useState } from "react"
import { defineWidgetConfig } from "@medusajs/admin-sdk"
import {
  DetailWidgetProps,
  AdminProductCategory,
} from "@medusajs/framework/types"
import { Spinner } from "@medusajs/icons"
import {
  Button,
  Container,
  Heading,
  Select,
  Text,
  toast,
} from "@medusajs/ui"

type CategoryOption = {
  id: string
  name: string
  handle: string
  parent_category_id: string | null
}

/**
 * Medusa 此版分類詳情沒有「父分類」欄位，用 widget 補上。
 */
const CategoryParentSelectWidget = ({
  data,
}: DetailWidgetProps<AdminProductCategory>) => {
  const [options, setOptions] = useState<CategoryOption[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [parentId, setParentId] = useState<string>(
    (data as { parent_category_id?: string | null }).parent_category_id ||
      "__none__",
  )

  const loadOptions = useCallback(async () => {
    setLoading(true)
    try {
      const response = await fetch(
        "/admin/product-categories?limit=200&fields=id,name,handle,parent_category_id",
        { credentials: "include" },
      )
      if (!response.ok) throw new Error("無法載入分類列表")
      const json = await response.json()
      const cats = (json.product_categories || []) as CategoryOption[]
      setOptions(
        cats
          .filter((c) => c.id !== data.id)
          .sort((a, b) => a.name.localeCompare(b.name, "zh-TW")),
      )
      const current =
        (data as { parent_category_id?: string | null }).parent_category_id ||
        cats.find((c) => c.id === data.id)?.parent_category_id ||
        null
      setParentId(current || "__none__")
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "載入失敗"
      toast.error(message)
    } finally {
      setLoading(false)
    }
  }, [data])

  useEffect(() => {
    void loadOptions()
  }, [loadOptions])

  const labelById = useMemo(() => {
    const map = new Map(options.map((o) => [o.id, `${o.name} (/${o.handle})`]))
    return map
  }, [options])

  const save = async () => {
    setSaving(true)
    try {
      const nextParent =
        parentId === "__none__" ? null : parentId

      const response = await fetch(`/admin/product-categories/${data.id}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parent_category_id: nextParent,
        }),
      })

      if (!response.ok) {
        const err = await response.json().catch(() => ({}))
        throw new Error(err.message || err.error || "儲存失敗")
      }

      toast.success(
        nextParent
          ? `已設父分類：${labelById.get(nextParent) || nextParent}`
          : "已改為頂層分類",
      )
      // 讓 Medusa admin 重新抓詳情
      window.location.reload()
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "儲存失敗"
      toast.error(message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Container className="divide-y p-0">
      <div className="px-6 py-4">
        <Heading level="h2">父分類</Heading>
        <Text size="small" className="text-ui-fg-subtle mt-1">
          此版 Medusa 後台沒有內建父分類欄位；在此設定後會出現在父層「底下」。
        </Text>
      </div>
      <div className="flex flex-col gap-3 px-6 py-4">
        {loading ? (
          <div className="flex items-center gap-2">
            <Spinner className="animate-spin text-ui-fg-muted" />
            <Text size="small">載入中…</Text>
          </div>
        ) : (
          <>
            <div className="w-full max-w-md">
              <Select
                value={parentId}
                onValueChange={(v) => setParentId(v)}
              >
                <Select.Trigger>
                  <Select.Value placeholder="選擇父分類" />
                </Select.Trigger>
                <Select.Content>
                  <Select.Item value="__none__">（無／頂層）</Select.Item>
                  {options.map((opt) => (
                    <Select.Item key={opt.id} value={opt.id}>
                      {opt.name} (/{opt.handle})
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select>
            </div>
            <div>
              <Button
                size="small"
                variant="secondary"
                disabled={saving}
                onClick={() => void save()}
              >
                {saving ? "儲存中…" : "儲存父分類"}
              </Button>
            </div>
          </>
        )}
      </div>
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "product_category.details.side.before",
})

export default CategoryParentSelectWidget
