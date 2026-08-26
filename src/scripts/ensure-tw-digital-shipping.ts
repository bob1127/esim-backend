import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import {
  createShippingOptionsWorkflow,
  linkSalesChannelsToStockLocationWorkflow,
} from "@medusajs/medusa/core-flows"

/**
 * eSIM 數位交付：確保台灣 (tw) 有免運 shipping option，
 * 否則結帳 `/store/shipping-options` 會回空陣列 → 前端「無可用運費」。
 *
 * 執行：npx medusa exec ./src/scripts/ensure-tw-digital-shipping.ts
 */
export default async function ensureTwDigitalShipping({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const link = container.resolve(ContainerRegistrationKeys.LINK)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const fulfillment = container.resolve(Modules.FULFILLMENT)
  const regionModule = container.resolve(Modules.REGION)
  const salesChannelModule = container.resolve(Modules.SALES_CHANNEL)
  const stockLocationModule = container.resolve(Modules.STOCK_LOCATION)

  const OPTION_NAME = "eSIM Digital Delivery"

  const regions = await regionModule.listRegions({}, { take: 20 })
  const twRegion =
    regions.find((r) =>
      (r.countries || []).some(
        (c: { iso_2?: string }) => String(c.iso_2 || "").toLowerCase() === "tw"
      )
    ) || regions.find((r) => /taiwan|台灣|tw/i.test(String(r.name || "")))

  if (!twRegion?.id) {
    throw new Error("找不到台灣 Region（countries 含 tw）。請先在 Admin 建立 Taiwan 區域。")
  }
  logger.info(`Region: ${twRegion.name} (${twRegion.id}) currency=${twRegion.currency_code}`)

  const existingOptions = await fulfillment.listShippingOptions(
    { name: OPTION_NAME },
    { take: 5 }
  )
  if (existingOptions.length) {
    logger.info(`已存在運費方案「${OPTION_NAME}」(${existingOptions[0].id})，略過建立。`)
    return
  }

  let salesChannels = await salesChannelModule.listSalesChannels({
    name: "Default Sales Channel",
  })
  if (!salesChannels.length) {
    salesChannels = await salesChannelModule.listSalesChannels({}, { take: 1 })
  }
  if (!salesChannels.length) {
    throw new Error("找不到 Sales Channel")
  }

  let stockLocations = await stockLocationModule.listStockLocations({}, { take: 5 })
  if (!stockLocations.length) {
    stockLocations = await stockLocationModule.createStockLocations([
      {
        name: "Jeko Digital Warehouse",
        address: {
          city: "Taipei",
          country_code: "TW",
          address_1: "eSIM digital",
        },
      },
    ])
    logger.info(`已建立 stock location: ${stockLocations[0].id}`)
  }
  const stockLocation = stockLocations[0]

  await linkSalesChannelsToStockLocationWorkflow(container).run({
    input: {
      id: stockLocation.id,
      add: [salesChannels[0].id],
    },
  })

  try {
    await link.create({
      [Modules.STOCK_LOCATION]: { stock_location_id: stockLocation.id },
      [Modules.FULFILLMENT]: { fulfillment_provider_id: "manual_manual" },
    })
  } catch {
    // already linked
  }

  const profiles = await fulfillment.listShippingProfiles({}, { take: 10 })
  const shippingProfile =
    profiles.find((p) => p.type === "default") || profiles[0]
  if (!shippingProfile?.id) {
    throw new Error("找不到 Shipping Profile")
  }

  let serviceZoneId: string | null = null
  const fulfillmentSets = await fulfillment.listFulfillmentSets(
    {},
    { take: 50, relations: ["service_zones", "service_zones.geo_zones"] }
  )

  for (const set of fulfillmentSets) {
    for (const zone of set.service_zones || []) {
      const hasTw = (zone.geo_zones || []).some(
        (g: { country_code?: string }) =>
          String(g.country_code || "").toLowerCase() === "tw"
      )
      if (hasTw) {
        serviceZoneId = zone.id
        logger.info(`重用既有 TW service zone: ${zone.name} (${zone.id})`)
        break
      }
    }
    if (serviceZoneId) break
  }

  if (!serviceZoneId) {
    const fulfillmentSet = await fulfillment.createFulfillmentSets({
      name: "Jeko eSIM Digital Delivery",
      type: "shipping",
      service_zones: [
        {
          name: "Taiwan",
          geo_zones: [{ type: "country", country_code: "tw" }],
        },
      ],
    })
    serviceZoneId = fulfillmentSet.service_zones?.[0]?.id
    if (!serviceZoneId) {
      throw new Error("建立 fulfillment set 後找不到 service zone")
    }
    logger.info(`已建立 fulfillment set / TW zone: ${serviceZoneId}`)

    try {
      await link.create({
        [Modules.STOCK_LOCATION]: { stock_location_id: stockLocation.id },
        [Modules.FULFILLMENT]: { fulfillment_set_id: fulfillmentSet.id },
      })
    } catch {
      // already linked
    }
  } else {
    // 確保 stock location 有連到含此 zone 的 fulfillment set
    const owningSet = fulfillmentSets.find((s) =>
      (s.service_zones || []).some((z) => z.id === serviceZoneId)
    )
    if (owningSet?.id) {
      try {
        await link.create({
          [Modules.STOCK_LOCATION]: { stock_location_id: stockLocation.id },
          [Modules.FULFILLMENT]: { fulfillment_set_id: owningSet.id },
        })
      } catch {
        // already linked
      }
    }
  }

  const { result } = await createShippingOptionsWorkflow(container).run({
    input: [
      {
        name: OPTION_NAME,
        price_type: "flat",
        provider_id: "manual_manual",
        service_zone_id: serviceZoneId,
        shipping_profile_id: shippingProfile.id,
        type: {
          label: "Digital",
          description: "eSIM delivered by email / QR code",
          code: "digital",
        },
        prices: [
          { currency_code: "twd", amount: 0 },
          { region_id: twRegion.id, amount: 0 },
        ],
        rules: [
          {
            attribute: "enabled_in_store",
            value: "true",
            operator: "eq",
          },
          {
            attribute: "is_return",
            value: "false",
            operator: "eq",
          },
        ],
      },
    ],
  })

  logger.info(
    `✅ 已建立運費方案「${OPTION_NAME}」: ${JSON.stringify(result?.[0]?.id || result)}`
  )

  // sanity: products without shipping profile will still fail; log profile id for admin
  const { data: sampleProducts } = await query.graph({
    entity: "product",
    fields: ["id", "title", "shipping_profile.id"],
    pagination: { take: 3 },
  })
  logger.info(
    `樣本商品 shipping_profile: ${JSON.stringify(
      (sampleProducts || []).map((p: any) => ({
        title: p.title,
        profile: p.shipping_profile?.id || null,
      }))
    )}`
  )
}
