import {
  capReferralProfit,
  buildReferralOrderMetadata,
  DEFAULT_REFERRAL_RATE,
} from "../referralOrderSync"
import { computeOrderProfit } from "../orderProfit"

/** 與前台 lib/partnerReferral.js computeReferralProfit 對照用 */
function computeReferralProfit(
  amountOrCost: number,
  ratePercent: number,
  sellPrice?: number,
) {
  const rate = Number(ratePercent)
  const pct = Number.isFinite(rate) && rate > 0 ? rate : DEFAULT_REFERRAL_RATE
  const base = Number(amountOrCost) || 0
  const raw = Math.round((base * pct) / 100)
  if (sellPrice != null && Number.isFinite(Number(sellPrice))) {
    const sell = Number(sellPrice)
    const gross = Math.max(0, sell - base)
    return Math.min(Math.max(0, raw), gross)
  }
  return Math.max(0, raw)
}

describe("referralOrderSync", () => {
  describe("capReferralProfit", () => {
    it("成本 168、售價 242（9 折）、25% → 分潤 42，與前台 computeReferralProfit 一致", () => {
      const cost = 168
      const sell = 242
      const raw = Math.round((cost * 25) / 100)
      expect(raw).toBe(42)
      expect(capReferralProfit(raw, cost, sell)).toBe(42)
      expect(computeReferralProfit(cost, 25, sell)).toBe(42)
    })

    it("毛利不足時封頂（低毛利方案）", () => {
      const cost = 200
      const sell = 210
      const raw = Math.round((cost * 25) / 100) // 50
      expect(capReferralProfit(raw, cost, sell)).toBe(10)
      expect(computeReferralProfit(cost, 25, sell)).toBe(10)
    })

    it("售價低於成本時封頂為 0", () => {
      expect(capReferralProfit(50, 200, 150)).toBe(0)
    })

    it("成本為 0 時以整單售價為毛利上限", () => {
      // 缺 cost_price 的異常單：raw 50 仍會被售價 240 封頂（實務上 notify 會 warn）
      expect(capReferralProfit(50, 0, 240)).toBe(50)
    })
  })

  describe("buildReferralOrderMetadata", () => {
    it("成功同步時寫入 referral_* 鍵，且不寫 partner_id", () => {
      const meta = buildReferralOrderMetadata({
        ok: true,
        partnerId: 7,
        referralCode: "tokyo-travel",
        ratePercent: 25,
        b2bCost: 168,
        partnerProfit: 42,
      })
      expect(meta.referral_partner_id).toBe("7")
      expect(meta.referral_b2b_cost).toBe(168)
      expect(meta.referral_partner_profit).toBe(42)
      expect(meta.referral_rate_percent).toBe(25)
      expect(meta.referral_synced_at).toBeTruthy()
      expect(meta).not.toHaveProperty("partner_id")
    })

    it("失敗或略過時回傳空物件", () => {
      expect(buildReferralOrderMetadata({ ok: false, skipped: "no_referral_code" })).toEqual({})
      expect(buildReferralOrderMetadata({ ok: true, skipped: "locked_status" })).toEqual({})
    })
  })
})

describe("orderProfit referral channel", () => {
  it("有 jeko_referral_code 時判定為 referral 並扣夥伴分潤", () => {
    const order = {
      id: "order_test123",
      total: 242,
      metadata: {
        jeko_referral_code: "tokyo-travel",
        referral_partner_profit: 42,
        referral_partner_id: "7",
        newebpay_amount: 242,
      },
      items: [
        {
          product_title: "北美 3 日",
          quantity: 1,
          unit_price: 242,
          variant: { metadata: { cost_price: 168 } },
        },
      ],
    }
    const profit = computeOrderProfit(order)
    expect(profit.channel).toBe("referral")
    expect(profit.referral_code).toBe("tokyo-travel")
    expect(profit.partner_profit).toBe(42)
    expect(profit.cost).toBe(168)
    expect(profit.revenue).toBe(242)
    expect(profit.platform_profit).toBe(242 - 168 - 42)
    expect(profit.partner_id).toBe("7")
  })

  it("夥伴店訂單仍走 partner 通道（優先於 referral code）", () => {
    const order = {
      id: "order_store",
      total: 30000,
      metadata: {
        is_partner_order: true,
        partner_id: "3",
        partner_store_id: "12",
        partner_b2b_cost: 200,
        partner_profit: 50,
        partner_total: 300,
        jeko_referral_code: "should-not-win",
      },
      items: [],
    }
    expect(computeOrderProfit(order).channel).toBe("partner")
  })
})
