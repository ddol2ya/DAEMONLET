import { describe, expect, it } from "vitest"
import { defaultDesktopSettings, normalizeDesktopSettings, validateDesktopSettingsPatch, windowSizeForScale } from "../electron/shared/desktop-settings"

describe("desktop settings", () => {
  it("provides safe defaults", () => {
    expect(defaultDesktopSettings()).toMatchObject({ schemaVersion: 1, characterId: "gpichan", scale: 1, visible: true, clickThrough: true, bounds: { width: 460, height: 460 } })
  })

  it("loads valid settings without migration", () => {
    const settings = defaultDesktopSettings()
    expect(normalizeDesktopSettings(settings)).toEqual({ value: settings, migrated: false, warnings: [] })
  })

  it.each(["gpichan"] as const)("persists %s without changing the default character", (characterId) => {
    const settings = { ...defaultDesktopSettings(), characterId }
    expect(normalizeDesktopSettings(JSON.parse(JSON.stringify(settings)))).toEqual({ value: settings, migrated: false, warnings: [] })
    expect(validateDesktopSettingsPatch({ characterId })).toEqual({ characterId })
    expect(defaultDesktopSettings().characterId).toBe("gpichan")
  })

  it("falls back from a retired built-in and accepts it again when installed as a pack", () => {
    const settings = { ...defaultDesktopSettings(), characterId: "asuma-toki" }
    expect(normalizeDesktopSettings(settings).value.characterId).toBe("gpichan")
    expect(normalizeDesktopSettings(settings, id => id === "asuma-toki").value.characterId).toBe("asuma-toki")
  })

  it("migrates partial settings and clamps unsafe sizes", () => {
    const result = normalizeDesktopSettings({ characterId: "longhair", scale: 1.5, bounds: { x: -120, y: 10, width: 900, height: 4 } })
    expect(result.value).toMatchObject({ characterId: "gpichan", scale: 1.5, bounds: { x: -120, width: 690, height: 690 } })
    expect(result.migrated).toBe(true)
  })

  it.each(["bell", "momo", "longhair", "asuma-toki", "asuma-toki-v2"])("migrates retired %s without losing display preferences", (characterId) => {
    const old = { ...defaultDesktopSettings(), characterId, scale: .8, visible: false, speechBubblesEnabled: false, bounds: { x: 83, y: 124, width: 368, height: 368, displayId: 7 } }
    expect(normalizeDesktopSettings(old)).toMatchObject({ migrated: true, value: { ...old, characterId: "gpichan" } })
    expect(validateDesktopSettingsPatch({ characterId })).toBeNull()
  })

  it("falls back from unknown characters and invalid input", () => {
    expect(normalizeDesktopSettings({ schemaVersion: 1, characterId: "unknown" }).value.characterId).toBe("gpichan")
    expect(normalizeDesktopSettings(null).value).toEqual(defaultDesktopSettings())
  })

  it("validates narrow patches and scale bounds", () => {
    expect(validateDesktopSettingsPatch({ characterId: "gpichan", scale: 1.25, visible: false })).toEqual({ characterId: "gpichan", scale: 1.25, visible: false })
    expect(validateDesktopSettingsPatch({ arbitrary: true })).toBeNull()
    expect(validateDesktopSettingsPatch({ scale: 99 })).toBeNull()
    expect(validateDesktopSettingsPatch({ visible: "yes" })).toBeNull()
    expect(windowSizeForScale(0.1)).toBe(280)
    expect(windowSizeForScale(3)).toBe(720)
  })
})

describe("speech bubble desktop settings", () => {
  it("defaults true and migrates old files preserving scale and location", () => {
    const { speechBubblesEnabled: _removed, ...old } = { ...defaultDesktopSettings(), characterId: "momo", scale: .8, bounds: { x: 100, y: 200, width: 368, height: 368, displayId: 7 } }
    expect(normalizeDesktopSettings(old)).toMatchObject({ migrated: true, value: { characterId: "gpichan", scale: .8, speechBubblesEnabled: true, bounds: old.bounds } })
  })
  it.each([true, false])("round-trips and validates toggle %s", (speechBubblesEnabled) => {
    const settings = { ...defaultDesktopSettings(), speechBubblesEnabled }
    expect(normalizeDesktopSettings(JSON.parse(JSON.stringify(settings)))).toEqual({ value: settings, migrated: false, warnings: [] })
    expect(validateDesktopSettingsPatch({ speechBubblesEnabled })).toEqual({ speechBubblesEnabled })
    expect(validateDesktopSettingsPatch({ speechBubblesEnabled: String(speechBubblesEnabled) })).toBeNull()
  })
})
