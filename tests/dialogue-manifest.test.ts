import { afterEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { loadDialogueManifest, parseDialogueManifest } from "../src/dialogue/DialogueManifest"
import { dialogueManifest } from "./helpers/dialogue"

afterEach(() => vi.unstubAllGlobals())
describe("dialogue manifest", () => {
  it("accepts different lines for poses sharing a trigger, with the same text bounds", () => {
    const manifest = dialogueManifest()
    manifest.poseTriggers = { happy: 'run.completed.observed', 'happy-double-v': 'run.completed.observed' }
    manifest.poseLines = { happy: ['  수고하셨습니다.  ', '수고하셨습니다.'], 'happy-double-v': ['피스, 피스.'] }
    expect(parseDialogueManifest(manifest).poseLines).toEqual({ happy: ['수고하셨습니다.'], 'happy-double-v': ['피스, 피스.'] })
  })
  it.each([undefined, {}, { writing: [] }, { writing: Array(21).fill('대기합니다.') },
    { writing: ['한'.repeat(37)] }, { writing: ['<b>대기</b>'] }, { writing: ['대기\u202e'] },
    { absent: ['대기합니다.'] }, { toString: ['대기합니다.'] }, { writing: '대기합니다.' },
  ].map(poseLines => ({ poseLines })))("rejects missing bindings or invalid pose lines %#", ({ poseLines }) => {
    const manifest = dialogueManifest()
    manifest.poseTriggers = poseLines === undefined ? undefined : { writing: 'run.started' }
    expect(() => parseDialogueManifest({ ...manifest, poseLines: poseLines ?? { writing: ['대기합니다.'] } })).toThrow()
  })

  it("supports dialogue for all 64 poses and rejects a 65th binding", async () => {
    const manifest = dialogueManifest()
    manifest.poseTriggers = Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`pose-${i}`, 'run.started' as const]))
    manifest.poseLines = Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`pose-${i}`, ['대기합니다.']]))
    expect(Object.keys(parseDialogueManifest(manifest).poseLines!)).toHaveLength(64)
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify(manifest) }))
    expect(Object.keys((await loadDialogueManifest("/dialogue")).manifest!.poseTriggers!)).toHaveLength(64)
    manifest.poseTriggers['pose-64'] = 'run.started'
    expect(() => parseDialogueManifest(manifest)).toThrow('Invalid dialogue manifest')
    delete manifest.poseTriggers['pose-64']
    manifest.poseLines['pose-64'] = ['대기합니다.']
    expect(() => parseDialogueManifest(manifest)).toThrow('Invalid dialogue manifest')
  })

  it("loads Gpichan's complete pose voice in formal Korean", () => {
    const character=JSON.parse(readFileSync('public/characters/gpichan/character.json','utf8'))
    const manifest=parseDialogueManifest(JSON.parse(readFileSync('public/characters/gpichan/'+character.dialogue,'utf8')))
    expect(Object.keys(manifest.poseTriggers!)).toEqual(expect.arrayContaining(['base',...character.poses.map((p:string)=>p.split('/')[1])]))
    for(const entry of Object.values(manifest.triggers))for(const line of entry!.lines){
      expect(line).not.toMatch(/요[.!?…]?$/)
      expect(line).toMatch(/(?:다|까|오)[.!?]$/)
    }
  })

  it.each([
    {waiting:'unknown'},
    {'../writing':'run.started'},
    {'':'run.started'},
    {waiting:'state.waiting'},
    {},
  ])("rejects unsafe or dangling pose bindings %#", (poseTriggers) => {
    const manifest=dialogueManifest()
    delete manifest.triggers['state.waiting']
    expect(()=>parseDialogueManifest({...manifest,poseTriggers})).toThrow('Invalid dialogue manifest')
  })

  it.each(["finite", "legacy", "legacy-alt"])("loads the independent %s voice", (id) => {
    const value = parseDialogueManifest(JSON.parse(readFileSync(`tests/fixtures/profiles/${id}/dialogue.ko.json`, "utf8")))
    expect(value.locale).toBe("ko-KR")
    expect(Object.keys(value.triggers)).toHaveLength(19)
    expect(value.triggers["run.completed.observed"]!.lines.join()).not.toMatch(/완벽|성공|해결했/)
  })
  it.each([
    ["unknown trigger", (m: any) => { m.triggers.unknown = m.triggers["run.started"] }],
    ["unknown root field", (m: any) => { m.extra = true }],
    ["unknown setting", (m: any) => { m.settings.extra = true }],
    ["unknown entry field", (m: any) => { m.triggers["run.started"].extra = true }],
    ["bad locale", (m: any) => { m.locale = "en" }],
    ["bad schema", (m: any) => { m.schemaVersion = 2 }],
    ["fractional priority", (m: any) => { m.triggers["run.started"].priority = 1.1 }],
    ["priority overflow", (m: any) => { m.triggers["run.started"].priority = 101 }],
    ["negative probability", (m: any) => { m.triggers["run.started"].probability = -1 }],
    ["infinite probability", (m: any) => { m.triggers["run.started"].probability = Infinity }],
    ["negative cooldown", (m: any) => { m.triggers["run.started"].cooldownMs = -1 }],
    ["cooldown overflow", (m: any) => { m.triggers["run.started"].cooldownMs = 600001 }],
    ["long display", (m: any) => { m.triggers["run.started"].displayMs = 6001 }],
    ["short display", (m: any) => { m.triggers["run.started"].displayMs = 799 }],
    ["unknown mode", (m: any) => { m.triggers["run.started"].mode = "replace-all" }],
    ["empty lines", (m: any) => { m.triggers["run.started"].lines = [] }],
    ["too many lines", (m: any) => { m.triggers["run.started"].lines = Array(21).fill("안녕") }],
    ["queue overflow", (m: any) => { m.settings.maxQueueSize = 6 }],
    ["character overflow", (m: any) => { m.settings.maxCharacters = 37 }],
  ])("rejects %s", (_name, change) => {
    const manifest = dialogueManifest()
    change(manifest)
    expect(() => parseDialogueManifest(manifest)).toThrow("Invalid dialogue manifest")
  })
  it.each([" ", "한".repeat(37), "a\nb", "a\r", "a\t", "\0", "\u007f", "\u0085", "\u2028", "\u202e", "<b>hello</b>", "{filename}", "{{command}}"])("rejects non-presentation text case %#", (text) => {
    const value = dialogueManifest()
    value.triggers["run.started"]!.lines = [text]
    expect(() => parseDialogueManifest(value)).toThrow()
  })
  it("counts Unicode code points and trims whitespace", () => {
    const value = dialogueManifest()
    value.triggers["run.started"]!.lines = ["  " + "😀".repeat(36) + "  "]
    expect(parseDialogueManifest(value).triggers["run.started"]!.lines[0]).toHaveLength(72)
  })
  it("disables only dialogue for missing, failed and invalid assets without logging input", async () => {
    const log = vi.spyOn(console, "error")
    expect((await loadDialogueManifest()).manifest).toBeNull()
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }))
    expect((await loadDialogueManifest("/missing")).manifest).toBeNull()
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: async () => "{" }))
    expect((await loadDialogueManifest("/bad")).warnings).toHaveLength(1)
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("private loader detail")))
    expect(JSON.stringify(await loadDialogueManifest("/private"))).not.toContain("private")
    expect(log).not.toHaveBeenCalled()
    log.mockRestore()
  })
  it("propagates cancellation instead of installing a stale profile", async () => {
    const controller = new AbortController()
    controller.abort()
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError")))
    await expect(loadDialogueManifest("/dialogue", controller.signal)).rejects.toHaveProperty("name", "AbortError")
  })
})
