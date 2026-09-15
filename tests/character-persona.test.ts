import { describe, expect, it } from "vitest"
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { parseCharacterPersona, validateCharacterPersona, neutralPersona } from "../electron/shared/character-persona"
import { compilePersona } from "../electron/main/side-chat/PersonaCompiler"
import { PersonaResolver } from "../electron/main/side-chat/PersonaResolver"
import { packFiles, writePayload, rawZip } from "./helpers/character-pack"
import { validatePackDirectory, sha256 } from "../electron/main/CharacterPackAssets"
import { extractCharacterPack } from "../electron/main/CharacterPackArchive"
const bytes = (v: unknown) => Buffer.from(JSON.stringify(v))
const exec = promisify(execFile)

describe("persona v1", () => {
  it("normalizes optional fields and has stable hashes independent of input key order", () => {
    const p = neutralPersona(), reordered = { examples: [], speech: p.speech, identity: p.identity, schemaVersion: 1 }
    expect(validateCharacterPersona(reordered)).toEqual(p)
    const a = compilePersona("A", p, "ko"), b = compilePersona("A", validateCharacterPersona(reordered), "ko")
    expect(a.personaHash).toBe(b.personaHash); expect(a.bindingHash).not.toBe(compilePersona("A", p, "en").bindingHash)
    expect(a.profileInput).toContain('"profile"'); expect(a.developerInstructions).not.toContain('"profile"')
  })
  it.each([
    (p: any) => { p.schemaVersion = 2 }, (p: any) => { p.developerPrompt = "run shell" },
    (p: any) => { p.speech.model = "other" }, (p: any) => { p.identity.traits = Array(9).fill("x") },
    (p: any) => { p.identity.role = "x".repeat(241) }, (p: any) => { p.identity.background = "x".repeat(1201) },
    (p: any) => { p.identity.role = "\u0001" }, (p: any) => { p.identity.role = "\ud800" },
    (p: any) => { p.speech.defaultLength = "long" }, (p: any) => { p.speech.languagePolicy = "fixed" },
  ])("rejects invalid data (%#)", mutate => { const p = neutralPersona(); mutate(p); expect(() => parseCharacterPersona(bytes(p))).toThrow("PACK_PERSONA") })
  it("rejects byte overflow, malformed Unicode, and dangerous object keys", () => {
    expect(() => parseCharacterPersona(Buffer.alloc(16385, 32))).toThrow("PACK_PERSONA")
    expect(() => parseCharacterPersona(Buffer.from([0xff]))).toThrow("PACK_PERSONA")
    expect(() => validateCharacterPersona(JSON.parse(JSON.stringify(neutralPersona()).replace('"identity":{', '"identity":{"__proto__":{},')))).toThrow("PACK_PERSONA")
    const p = neutralPersona(); p.identity.role = "a\r\nb\tc"; expect(validateCharacterPersona(p).identity.role).toBe("a\nb c")
  })
  it("resolves explicit referenced profiles or neutral legacy, never orphan persona files", async () => {
    const character = { schemaVersion: 1, id: "legacy", label: "Legacy", base: { psd: "a.psd", source: "a.png" }, poses: [] }
    let reads = 0
    const resolver = new PersonaResolver(async (_selection, path) => { reads++; return path === "character.json" ? bytes(character) : bytes(neutralPersona()) })
    const result = await resolver.resolve({ id: "legacy", revision: "builtin" }, "ko")
    expect(result.compiled.personaHash).toBe(compilePersona("Legacy", neutralPersona(), "ko").personaHash); expect(reads).toBe(1)
    Object.assign(character, { persona: "../../persona.json" })
    await expect(resolver.resolve({ id: "legacy", revision: "builtin" }, "ko")).rejects.toThrow("PACK_PERSONA")
  })
  it("validates the built-in persona and actual distribution graph", async () => {
    const p = parseCharacterPersona(await readFile("public/characters/gpichan/persona.json"))
    expect(p.speech.formality).toBe("formal"); expect(p.identity.background).toBe("")
    const { runtimeAssetPaths } = await import("../scripts/release/runtime-assets.mjs")
    expect(await runtimeAssetPaths("public/characters")).toContain("gpichan/persona.json")
  })
})

describe("persona pack migration", () => {
  it("exports legacy without capability; upgrades and re-imports, preserving payload and metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "persona-test-"))
    try {
      const input = join(dir, "old.petchar"), persona = join(dir, "persona.json"), output = join(dir, "new.petchar"), report = join(dir, "report.json")
      const entries = packFiles({ extra: { author: "Synthetic author", thumbnail: "source.png", unsupportedReactions: ["happy"] } })
      const provenance = { path: "provenance.json", data: bytes({ unsupportedReactions: ["head-tap"] }) }
      const originalManifest = JSON.parse(entries[0].data.toString()); entries.push(provenance)
      originalManifest.files.push({ path: provenance.path, bytes: provenance.data.length, sha256: sha256(provenance.data) }); entries[0].data = bytes(originalManifest)
      await writeFile(input, rawZip(entries)); await writeFile(persona, bytes(neutralPersona()))
      await exec(process.execPath, ["scripts/characters/upgrade-pack-persona.mjs", "--input", input, "--persona", persona, "--version", "1.0.1", "--output", output, "--report", report])
      const result = JSON.parse(await readFile(report, "utf8"))
      expect(result.visualAssetChanges).toBe(0); expect(result.unchangedFiles).toHaveLength(entries.length - 2)
      const stage = await mkdtemp(join(dir, "import-")), validated = await extractCharacterPack(output, stage)
      expect(validated.manifest.author).toBe("Synthetic author"); expect(validated.manifest.thumbnail).toBe("source.png")
      expect(validated.manifest.unsupportedReactions).toEqual(["happy"])
      expect(validated.manifest.runtime.capabilities).toContain("side-chat-persona-v1")
      expect(await readFile(input)).toEqual(rawZip(entries))
      await expect(exec(process.execPath, ["scripts/characters/upgrade-pack-persona.mjs", "--input", input, "--persona", persona, "--version", "1.0.1", "--output", output, "--report", report])).rejects.toThrow()
      const legacy = join(dir, "legacy"), legacyOutput = join(dir, "legacy.petchar")
      await writePayload(legacy, entries.filter(e => e.path !== "pack.json"))
      await exec(process.execPath, ["scripts/characters/export-pack.mjs", "--character-root", legacy, "--version", "1.0.0", "--output", legacyOutput])
      const legacyStage = await mkdtemp(join(dir, "legacy-import-")); expect((await extractCharacterPack(legacyOutput, legacyStage)).manifest.runtime.capabilities).not.toContain("side-chat-persona-v1")
    } finally { await rm(dir, { recursive: true, force: true }) }
  }, 30_000)
  it.each(["missing-capability", "missing-reference", "tampered", "escape", "corrupt"])("rejects %s", async variant => {
    const dir = await mkdtemp(join(tmpdir(), "persona-bad-"))
    try {
      const entries = packFiles(), manifest = JSON.parse(entries[0].data.toString()), character = JSON.parse(entries[1].data.toString())
      const p = { path: "persona.json", data: bytes(variant === "corrupt" ? { ...neutralPersona(), endpoint: "http://bad" } : neutralPersona()) }
      entries.push(p)
      if (variant !== "missing-reference") character.persona = variant === "escape" ? "../persona.json" : "persona.json"
      entries[1].data = bytes(character)
      if (variant !== "missing-capability") manifest.runtime.capabilities.push("side-chat-persona-v1")
      manifest.files = entries.slice(1).map(e => ({ path: e.path, bytes: e.data.length, sha256: sha256(e.data) }))
      if (variant === "tampered") p.data = bytes({ ...neutralPersona(), examples: [{ user: "a", reply: "b" }] })
      entries[0].data = bytes(manifest); await writePayload(dir, entries)
      await expect(validatePackDirectory(dir)).rejects.toThrow(/PACK_/)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})
