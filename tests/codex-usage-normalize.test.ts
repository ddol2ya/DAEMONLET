import { describe, expect, it } from "vitest"
import { normalizeCodexUsage } from "../electron/main/codex-usage/normalizeCodexUsage"
import { emptyCodexUsage, newerCodexUsage } from "../electron/shared/codex-usage-contract"
import { usagePresentation } from "../src/activity-bubble/CodexUsageStrip"
import { createTranslator } from "../electron/shared/translations"
import { defaultDesktopSettings, normalizeDesktopSettings, validateDesktopSettingsPatch } from "../electron/shared/desktop-settings"
const w = (duration: unknown, used: unknown = 24, resetsAt: unknown = 1800000000) => ({ windowDurationMins: duration, usedPercent: used, resetsAt })
const parse = (primary: unknown, secondary: unknown = null, extra = {}) => normalizeCodexUsage({ rateLimits: { primary, secondary }, ...extra })!
describe("Codex account quota normalization", () => {
  it("classifies durations, including reversed, weekly-only and absent windows", () => {
    const both = parse(w(300), w(10080, 61))
    expect(both).toEqual(parse(w(10080, 61), w(300)))
    expect(both.fiveHour).toMatchObject({ usedPercent: 24, resetsAtMs: 1800000000000 })
    expect(parse(w(10080)).fiveHour).toBeNull(); expect(parse(w(10080)).weekly?.usedPercent).toBe(24)
    expect(parse(w(300)).weekly).toBeNull(); expect(parse(null).fiveHour).toBeNull()
  })
  it.each([null, undefined, 60, "300"])("does not guess duration %s", duration => expect(parse(w(duration)).fiveHour).toBeNull())
  it("rejects duplicates instead of combining them", () => expect(parse(w(300), w(300, 30)).fiveHour).toBeNull())
  it("prefers explicit codex; never merges model, reserve or credits", () => {
    const codex = { limitId: "codex", primary: w(10080, 61), secondary: null }
    const result = parse(w(300, 90), null, { rateLimitsByLimitId: { codex, codex_other: { primary: w(300, 12) } } })
    expect(result.fiveHour).toBeNull(); expect(result.weekly?.usedPercent).toBe(61)
    for (const bad of [null, [], { ...codex, limitId: "codex_other" }]) expect(parse(w(300), null, { rateLimitsByLimitId: { codex: bad } })).toBeNull()
    expect(parse(w(300), null, { rateLimits: { limitId: "reserve", primary: w(300) } })).toBeNull()
    expect(parse(null, null, { credits: { unlimited: true } }).fiveHour).toBeNull()
  })
  it.each(["24", -1, NaN, Infinity, undefined, Number.MAX_VALUE])("rejects invalid percent %s", used => expect(parse({ ...w(300), usedPercent: used }).fiveHour).toBeNull())
  it.each([0, 99.6, 100, 125])("preserves finite percent %s without inferring permission", used => {
    expect(parse(w(300, used)).fiveHour?.usedPercent).toBe(used)
    expect(parse(w(300, used)).ordinaryUsageAllowed).toBeNull()
    expect(parse(w(300, used), null, { ordinaryUsageAllowed: false }).ordinaryUsageAllowed).toBe(false)
    expect(parse(w(300, used), null, { ordinaryUsageAllowed: true }).ordinaryUsageAllowed).toBe(true)
  })
  it.each([null, "1800000000", 1800000000000, Infinity, -1])("does not invent reset timestamp %s", reset => {
    expect(parse(w(300, 0, reset)).fiveHour).toMatchObject({ usedPercent: 0, resetsAtMs: null })
  })
  it("allows missing/null legacy ID and rejects invalid top-level data", () => {
    for (const id of [null, undefined, "codex"]) expect(normalizeCodexUsage({ rateLimits: { limitId: id, primary: w(300) } })?.fiveHour).not.toBeNull()
    for (const raw of [null, [], 5, { rateLimitsByLimitId: [] }]) expect(normalizeCodexUsage(raw)).toBeNull()
  })
  it("labels used/remaining and restriction independently in both languages", () => {
    const snapshot = { ...emptyCodexUsage(), ...parse(w(300, 24), w(10080, 125), { ordinaryUsageAllowed: false }), enabled: true, state: "ready" as const, observedAtMs: 1800000000000 }
    const en = usagePresentation(snapshot, createTranslator("en")), ko = usagePresentation(snapshot, createTranslator("ko"))
    expect(en.description).toContain("24% used"); expect(en.description).toContain("76% remaining"); expect(en.description).toContain("125% used"); expect(en.description).toContain("0% remaining"); expect(en.limited).toBe("Usage restricted")
    expect(ko.description).toContain("24% 사용"); expect(ko.description).toContain("76% 남음")
  })
  it.each(["ko", "en"] as const)("shows only supplied quota windows in %s, including a real zero", language => {
    const t = createTranslator(language)
    const view = (primary: unknown, secondary: unknown = null) => usagePresentation({ ...emptyCodexUsage(), ...parse(primary, secondary), state: "ready", enabled: true }, t)
    const weekly = view(w(10080, 0))
    expect(weekly.windows).toHaveLength(1)
    expect(weekly.windows[0].text).toBe(language === "ko" ? "주간 0% 사용" : "Weekly 0% used")
    expect(weekly.description).not.toMatch(/5시간|5h/)
    expect(view(w(300)).windows).toHaveLength(1)
    expect(view(w(300), w(10080)).windows).toHaveLength(2)
    expect(view(null).windows).toHaveLength(2)
    expect(view(null).windows.every(window => window.text.endsWith("—"))).toBe(true)
  })
  it("drops late initial revisions and strictly validates/migrates the boolean setting", () => {
    expect(newerCodexUsage({ ...emptyCodexUsage(), revision: 9 }, { ...emptyCodexUsage(), revision: 1 }).revision).toBe(9)
    expect(defaultDesktopSettings().codexUsageEnabled).toBe(true)
    expect(normalizeDesktopSettings({}).value.codexUsageEnabled).toBe(true)
    expect(validateDesktopSettingsPatch({ codexUsageEnabled: false })).toEqual({ codexUsageEnabled: false })
    expect(validateDesktopSettingsPatch({ codexUsageEnabled: "false" })).toBeNull()
  })
})
