import { afterEach, describe, expect, it, vi } from "vitest"
import { EventEmitter } from "node:events"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import ts from "typescript"
import { readFileSync, readdirSync } from "node:fs"
import { APP_LANGUAGE_CHANGED, languageFromArguments, languageLocale } from "../electron/shared/app-language"
import { defaultDesktopSettings, normalizeDesktopSettings, validateDesktopSettingsPatch } from "../electron/shared/desktop-settings"
import { createTranslator, ENGLISH_MESSAGES, message } from "../electron/shared/translations"
import { appLanguage, bindWindowLanguage, languageArguments, readSavedAppLanguage, setAppLanguage } from "../electron/main/AppLanguage"
import { WindowBoundsStore } from "../electron/main/WindowBoundsStore"

const temporary: string[] = []
afterEach(async () => { setAppLanguage("ko"); await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

describe("persisted app language", () => {
  it("adds Korean to older settings without losing selected packs or display preferences", () => {
    const { language: _, ...old } = { ...defaultDesktopSettings(), characterId: "user-pack", scale: .8, bounds: { ...defaultDesktopSettings().bounds, width: 368, height: 368 }, speechBubblesEnabled: false }
    const result = normalizeDesktopSettings(old, id => id === "user-pack")
    expect(result).toMatchObject({ migrated: true, value: { ...old, language: "ko" } })
  })
  it.each(["ko", "en"] as const)("saves and reloads %s before window startup without rewriting character settings", async language => {
    const root = await mkdtemp(join(tmpdir(), "daemonlet-language-")); temporary.push(root)
    const store = new WindowBoundsStore(root)
    const settings = { ...defaultDesktopSettings(), language, characterId: "external-pack" }
    await store.save(settings)
    const before = await readFile(store.path, "utf8")
    expect(await readSavedAppLanguage(root)).toBe(language)
    expect(await readFile(store.path, "utf8")).toBe(before)
    expect((await new WindowBoundsStore(root).load(id => id === "external-pack")).value).toEqual(settings)
    expect(validateDesktopSettingsPatch({ language })).toEqual({ language })
  })
  it.each([null, "fr", "en-US", "--locale=en-US", 1, {}, ["en"]])("rejects invalid language patches %j and defaults old input safely", language => {
    expect(validateDesktopSettingsPatch({ language })).toBeNull()
    expect(normalizeDesktopSettings({ ...defaultDesktopSettings(), language }).value.language).toBe("ko")
  })
  it("does not quarantine or modify malformed settings during the splash read", async () => {
    const root = await mkdtemp(join(tmpdir(), "daemonlet-language-")); temporary.push(root)
    const path = join(root, "desktop-settings.json")
    await writeFile(path, "invalid JSON")
    expect(await readSavedAppLanguage(root)).toBe("ko")
    expect(await readFile(path, "utf8")).toBe("invalid JSON")
  })
  it("accepts only an exact main-process language argument", () => {
    expect(languageFromArguments(["--daemonlet-language=en"])).toBe("en")
    expect(languageFromArguments(["--daemonlet-language=en-US", "--daemonlet-language=fr"])).toBe("ko")
    expect(languageLocale("ko")).toBe("ko-KR"); expect(languageLocale("en")).toBe("en-US")
  })
  it("updates every existing window, late loads and reloads, without reloading contents", () => {
    const make = () => Object.assign(new EventEmitter(), { isDestroyed: () => false, setTitle: vi.fn(), webContents: Object.assign(new EventEmitter(), { send: vi.fn(), reload: vi.fn() }) })
    const a = make(), b = make()
    bindWindowLanguage(a as never, "Daemonlet 설정"); bindWindowLanguage(b as never, "Daemonlet 작업 목록")
    setAppLanguage("en")
    for (const win of [a, b]) expect(win.webContents.send).toHaveBeenLastCalledWith(APP_LANGUAGE_CHANGED, "en")
    expect(a.setTitle).toHaveBeenLastCalledWith("Daemonlet settings")
    expect(languageArguments()).toEqual(["--daemonlet-language=en"])
    a.webContents.emit("did-finish-load")
    expect(a.webContents.send).toHaveBeenLastCalledWith(APP_LANGUAGE_CHANGED, "en")
    setAppLanguage("ko")
    b.webContents.emit("did-finish-load")
    expect(b.setTitle).toHaveBeenLastCalledWith("Daemonlet 작업 목록")
    expect(a.webContents.reload).not.toHaveBeenCalled()
    expect(b.webContents.reload).not.toHaveBeenCalled()
    a.emit("closed"); b.emit("closed")
    a.webContents.send.mockClear(); setAppLanguage("en")
    expect(a.webContents.send).not.toHaveBeenCalled(); expect(appLanguage()).toBe("en")
  })
})

describe("application translations", () => {
  it("reorders placeholders and never translates or reinterprets user-authored values", () => {
    const en = createTranslator("en"), ko = createTranslator("ko")
    const name = "캐릭터 · {1} <b>original</b>"
    expect(en`${name} ${"1.2.3"} 버전이 준비됐어요.`).toBe(`${name} version 1.2.3 is ready.`)
    expect(ko`${name} ${"1.2.3"} 버전이 준비됐어요.`).toBe(`${name} 1.2.3 버전이 준비됐어요.`)
    const stored = message`종료 이력은 최대 ${100}건, ${7}일 보관합니다. 미확인 결과도 보관 한도에 따라 정리됩니다. 대화 제목과 본문은 저장하지 않습니다.`
    expect(en(stored)).toContain("up to 7 days and 100 entries")
    expect(ko(stored)).toContain("100건, 7일")
    for (const unknown of ["constructor", "__proto__", "toString", "user-authored value"]) expect(en(unknown)).toBe(unknown)
  })
  it("keeps all translation placeholders intact", () => {
    const slots = (value: string) => [...value.matchAll(/\{(\d+)\}/g)].map(v => v[1]).sort()
    for (const [key, value] of Object.entries(ENGLISH_MESSAGES)) {
      expect(value.trim(), key).not.toBe("")
      expect(slots(value), key).toEqual(slots(key))
      expect(value, key).not.toMatch(/[가-힣]/)
    }
  })
  it("covers application UI strings and canonical status/error messages", () => {
    const directories = ["src/settings", "src/activity", "src/activity-bubble", "src/app", "src/pet"]
    const files = directories.flatMap(path => readdirSync(path).filter(f => /\.(tsx|ts)$/.test(f) && f !== "main.tsx").map(f => `${path}/${f}`))
      .concat(["electron/shared/character-pack-contract.ts", "electron/shared/activity-contract.ts", "electron/main/TrayController.ts", "electron/main/SettingsIpcController.ts", "electron/main/CharacterIpcController.ts", "electron/main/StartupWindow.ts"])
    const missing = new Set<string>()
    for (const path of files) {
      const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true)
      const check = (key: string) => { if (/[가-힣]/.test(key) && !["한국어", "언어 / Language"].includes(key) && !Object.hasOwn(ENGLISH_MESSAGES, key)) missing.add(`${path}: ${key}`) }
      const visit = (node: ts.Node) => {
        if (ts.isStringLiteralLike(node)) check(node.text)
        if (ts.isTaggedTemplateExpression(node) && ts.isTemplateExpression(node.template)) {
          let key = node.template.head.text
          node.template.templateSpans.forEach((span, i) => key += `{${i}}` + span.literal.text)
          check(key)
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
    expect([...missing]).toEqual([])
  })
})
