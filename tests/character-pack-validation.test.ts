import { afterEach, describe, expect, it } from "vitest"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validatePackPath, resolvePackReference, parsePackAssetUrl } from "../electron/shared/character-pack-path"
import { PACK_LIMITS, PACK_RUNTIME, comparePackVersions } from "../electron/shared/character-pack-contract"
import { parsePackManifest, parseBoundedJson, validateRigOverrides } from "../electron/shared/character-pack-validation"
import { preflightPsd, sha256, validatePackDirectory } from "../electron/main/CharacterPackAssets"
import { DEFAULT_BEHAVIOR_MANIFEST } from "../src/behavior/BehaviorManifest"
import { extractCharacterPack } from "../electron/main/CharacterPackArchive"
import { meshGridFor } from "../src/engine/anime25d/MeshLimits"
import type { RigLayer, RigDefinition } from "../src/engine/anime25d/types"
import { packFiles, rawZip, tinyPsd, writePayload, type ZipEntry } from "./helpers/character-pack"
import { dialogueManifest } from "./helpers/dialogue"

const temporary: string[] = []
async function temp() { const d = await mkdtemp(join(tmpdir(), "petchar-test-")); temporary.push(d); return d }
afterEach(async () => { await Promise.all(temporary.splice(0).map(d => rm(d, { recursive: true, force: true }))) })

function posePack(count: number, capability: boolean, choices?: string[]): ZipEntry[] {
  const entries = packFiles(), manifest = JSON.parse(entries.shift()!.data.toString())
  const character = JSON.parse(entries[0].data.toString())
  character.poses = Array.from({ length: count }, (_, i) => `pose-${i}.json`)
  for (let i = 0; i < count; i++) entries.push({ path: character.poses[i], data: Buffer.from(JSON.stringify({
    schemaVersion: 1, id: `pose-${i}`, label: `Pose ${i}`, source: "source.png", psd: "model.psd", overrides: "rig.json",
    strategy: "independent-model", registration: { strategy: "identity", maxScaleDelta: 0, maxRotationDeg: 0, maxAnchorErrorPx: 0 },
    layers: { sharedFromBase: [], replaceFromBase: [], useFromPose: [], addFromPose: [] },
    transition: { enterMs: 200, exitMs: 200, swapStart: .2, swapEnd: .8 },
  })) })
  if (choices) {
    const behavior = structuredClone(DEFAULT_BEHAVIOR_MANIFEST)
    behavior.states.BUSY = { poseId: null }
    behavior.states.NORMAL = { poseId: "pose-0", poseVariants: choices }
    character.behavior = "behavior.json"
    entries.push({ path: "behavior.json", data: Buffer.from(JSON.stringify(behavior)) })
  }
  entries[0].data = Buffer.from(JSON.stringify(character))
  const rig = entries.find(e => e.path === "rig.json")!
  rig.data = Buffer.from(JSON.stringify({ ...JSON.parse(rig.data.toString()), anchorOverrides: {
    eyeL: { x0: 21, y0: 28, x1: 29, y1: 35, icx: 25, icy: 31, closeY: 32 },
    eyeR: { x0: 35, y0: 28, x1: 43, y1: 35, icx: 39, icy: 31, closeY: 32 },
  } }))
  manifest.runtime.capabilities = PACK_RUNTIME.capabilities.filter(c => c !== "side-chat-persona-v1" && c !== "hf-pack-updates-v1" && c !== "character-chat-v1" && (c !== "pose-variants" || capability))
  manifest.files = entries.map(e => ({ path: e.path, bytes: e.data.length, sha256: sha256(e.data) }))
  return [{ path: "pack.json", data: Buffer.from(JSON.stringify(manifest)) }, ...entries]
}

describe("pose variant pack compatibility", () => {
  it.each([true, false])("requires the pose-dialogue capability for pose-specific lines: %s", async capability => {
    const entries = posePack(1, false), manifest = JSON.parse(entries.shift()!.data.toString())
    const character = JSON.parse(entries[0].data.toString()), dialogue = dialogueManifest()
    dialogue.poseTriggers = { 'pose-0': 'run.started' }
    dialogue.poseLines = { 'pose-0': ['기록하겠습니다.'] }
    character.dialogue = 'dialogue.ko.json'
    entries[0].data = Buffer.from(JSON.stringify(character))
    entries.push({ path: character.dialogue, data: Buffer.from(JSON.stringify(dialogue)) })
    manifest.runtime.capabilities = manifest.runtime.capabilities.filter((c: string) => c !== 'pose-dialogue' || capability)
    manifest.files = entries.map(e => ({ path: e.path, bytes: e.data.length, sha256: sha256(e.data) }))
    const dir = await writePayload(await temp(), [{ path: 'pack.json', data: Buffer.from(JSON.stringify(manifest)) }, ...entries])
    if (capability) expect((await validatePackDirectory(dir)).poseCount).toBe(1)
    else await expect(validatePackDirectory(dir)).rejects.toThrow('PACK_INCOMPATIBLE')
  })

  it.each([16, 22, 32, 34, 64])("validates %i poses through the real loader with the supported capability", async count => {
    const dir = await writePayload(await temp(), posePack(count, count > 16))
    expect((await validatePackDirectory(dir)).poseCount).toBe(count)
  })
  it("requires the capability before allowing more than 16 poses", async () => {
    const dir = await writePayload(await temp(), posePack(17, false))
    await expect(validatePackDirectory(dir)).rejects.toThrow("PACK_INCOMPATIBLE")
  })
  it("rejects 65 poses even with the extended capability", async () => {
    const dir = await writePayload(await temp(), posePack(65, true))
    await expect(validatePackDirectory(dir)).rejects.toThrow("PACK_LIMIT")
  })
  it("requires an explicit extension capability above the legacy 32-pose limit", async () => {
    const entries = posePack(34, true), manifest = JSON.parse(entries[0].data.toString())
    manifest.runtime.capabilities = manifest.runtime.capabilities.filter((c: string) => c !== "extended-pose-library-v1")
    entries[0].data = Buffer.from(JSON.stringify(manifest))
    const dir = await writePayload(await temp(), entries)
    await expect(validatePackDirectory(dir)).rejects.toThrow("PACK_INCOMPATIBLE")
  })
  it("requires the capability for behavior choices even in a small pack", async () => {
    const dir = await writePayload(await temp(), posePack(3, false, ["pose-1", "pose-2"]))
    await expect(validatePackDirectory(dir)).rejects.toThrow("PACK_INCOMPATIBLE")
  })
  it("resolves every alternative against the packaged pose inventory", async () => {
    const good = await writePayload(await temp(), posePack(3, true, ["pose-1", "pose-2"]))
    expect((await validatePackDirectory(good)).poseCount).toBe(3)
    const missing = await writePayload(await temp(), posePack(3, true, ["pose-1", "absent"]))
    await expect(validatePackDirectory(missing)).rejects.toThrow("PACK_SCHEMA")
  })
})

describe("external pack data boundary", () => {
  it.each(["../outside", "/absolute", "C:/drive", "\\\\server\\share", "a\\..\\b", "a:b", "a%252fsecret", "a\0.png", "A/CON.txt", "aux", "com1.png", "name.", "name ", "a//b", "./a", "a/../b", "e\u0301.png", "a/" + "b/".repeat(9) + "x", "a".repeat(181)])("rejects cross-platform path %s", path => expect(() => validatePackPath(path)).toThrow("PACK_PATH"))
  it("allows relative references only inside the revision, not arbitrary URLs", () => {
    expect(resolvePackReference("../source.png", "poses/pose.json", new Set(["source.png"]))).toBe("source.png")
    for (const ref of ["../../other/config.json", "//host/x", "https://host/x", "file:///secret", "data:text/plain,x", "%2e%2e/x", "~/secret"]) expect(() => resolvePackReference(ref, "poses/pose.json", new Set())).toThrow()
    expect(parsePackAssetUrl(`pet://app/character-packs/fresh/${"a".repeat(64)}/../secret`)).toBeNull()
    expect(parsePackAssetUrl(`pet://app/character-packs/fresh/${"a".repeat(64)}/%252e%252e/secret`)).toBeNull()
  })
  it("defines release version order and rejects ambiguous version rules", () => {
    expect(comparePackVersions("1.10.0", "1.2.0")).toBeGreaterThan(0)
    expect(() => comparePackVersions("1.0.0-beta", "1.0.0")).toThrow()
    expect(() => parsePackManifest(packFiles({ extra: { runtime: { engine: "anime25d", assetApiVersion: 2, capabilities: [] } } })[0].data)).toThrow("PACK_INCOMPATIBLE")
    expect(() => parsePackManifest(packFiles({ extra: { packFormatVersion: 2 } })[0].data)).toThrow("PACK_INCOMPATIBLE")
  })
  it("bounds JSON before parsing nested rig data and rejects pollution/unknown fields", () => {
    expect(() => parseBoundedJson(Buffer.from('{"__proto__":{"polluted":true}}'))).toThrow("PACK_SCHEMA")
    expect(() => parseBoundedJson(Buffer.from('[1e999]'))).toThrow("PACK_SCHEMA")
    expect(() => parseBoundedJson(Buffer.from('['.repeat(20) + '0' + ']'.repeat(20)))).toThrow("PACK_LIMIT")
    expect(() => parseBoundedJson(Buffer.from(JSON.stringify(new Array(2049).fill(0))))).toThrow("PACK_LIMIT")
    expect(() => parseBoundedJson(Buffer.alloc(PACK_LIMITS.jsonBytes + 1))).toThrow("PACK_LIMIT")
    expect(() => validateRigOverrides({ meshSources: { face: { path: "other" } } })).toThrow("PACK_SCHEMA")
    expect(() => validateRigOverrides({ headFollow: { face: { center: { cx: 2, cy: 3 }, radius: 30, falloffRadius: 2 } } })).toThrow("PACK_SCHEMA")
    expect(() => validateRigOverrides({ anchorOverrides: { mouth: { x0: 1 } } })).toThrow("PACK_SCHEMA")
    expect(() => validateRigOverrides({ physics: { frontHair: { execute: true } } })).toThrow("PACK_SCHEMA")
  })
  it("bounds PSD dimensions and WebGL indices before pixel/mesh allocation", () => {
    const psd = tinyPsd(); expect(preflightPsd(psd).layers).toBe(8)
    psd.writeUInt32BE(PACK_LIMITS.canvasSide + 1, 14)
    expect(() => preflightPsd(psd)).toThrow("PACK_LIMIT")
    expect(() => preflightPsd(Buffer.from("broken"))).toThrow("PACK_SCHEMA")
    expect(() => meshGridFor({ w: 2048, h: 2048, mouthExpression: "open" } as RigLayer, { canvas: { w: 1280 }, anchors: { mouth: { morph: {} } } } as RigDefinition)).toThrow("PACK_LIMIT")
  })
  it("validates actual PSD/rigger data with a new ID and no optional thumbnail", async () => {
    const dir = await writePayload(await temp())
    const pack = await validatePackDirectory(dir)
    expect(pack).toMatchObject({ manifest: { id: "fresh-character", name: "새 캐릭터" }, poseCount: 0 })
    expect(pack.revision).toMatch(/^[a-f0-9]{64}$/)
  })
  it("keeps external a valid character ID independently of Motion Lab modes", async () => {
    const dir = await writePayload(await temp(), packFiles({ id: "external" }))
    expect((await validatePackDirectory(dir)).manifest.id).toBe("external")
  })
  it("rejects missing, unlisted or modified inventory and executable data", async () => {
    const dir = await writePayload(await temp())
    await writeFile(join(dir, "script.js"), "alert(1)")
    await expect(validatePackDirectory(dir)).rejects.toThrow("PACK_INTEGRITY")
    await rm(join(dir, "script.js")); await writeFile(join(dir, "rig.json"), "{}")
    await expect(validatePackDirectory(dir)).rejects.toThrow("PACK_INTEGRITY")
  })
  it.each([
    [{ path: "../escape.json", data: Buffer.from("{}") }],
    [{ path: "a.json", data: Buffer.from("{}") }, { path: "A.json", data: Buffer.from("{}") }],
    [{ path: "A/x.json", data: Buffer.from("{}") }, { path: "a/y.json", data: Buffer.from("{}") }],
    [{ path: "é.json", data: Buffer.from("{}") }, { path: "e\u0301.json", data: Buffer.from("{}") }],
    [{ path: "link.json", data: Buffer.from("target"), mode: 0o120777 }],
    [{ path: "script.json", data: Buffer.from("{}"), mode: 0o100755 }],
    [{ path: "encrypted.json", data: Buffer.from("{}"), flags: 1 }],
    [{ path: "method.json", data: Buffer.from("{}"), method: 99 }],
    [{ path: "long.json", data: Buffer.from("{}"), size: PACK_LIMITS.fileBytes + 1 }],
  ] as ZipEntry[][])("rejects unsafe ZIP entry metadata %#", async (...entries: ZipEntry[]) => {
    const dir = await temp(), tx = join(dir, "tx"); await mkdir(tx)
    await writeFile(join(dir, "bad.zip"), rawZip(entries))
    await expect(extractCharacterPack(join(dir, "bad.zip"), tx)).rejects.toThrow()
  })
  it("checks local-vs-central headers and actual CRC", async () => {
    const dir = await temp(), tx = join(dir, "tx"); await mkdir(tx)
    const zip = rawZip(packFiles()); zip[30] ^= 1
    await writeFile(join(dir, "bad.zip"), zip)
    await expect(extractCharacterPack(join(dir, "bad.zip"), tx)).rejects.toThrow("PACK_INTEGRITY")
  })
})
