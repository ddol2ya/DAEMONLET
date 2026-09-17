import { describe, expect, it } from "vitest"
import { parsePackManifest } from "../electron/shared/character-pack-validation"
import { PACK_RUNTIME } from "../electron/shared/character-pack-contract"
import { parseUpdateFeed, parseUpdateSource, supportsUpdateRuntime, updateSourceKey } from "../electron/shared/pack-update-contract"
import { packFiles } from "./helpers/character-pack"

export const source = { schemaVersion: 1, provider: "huggingface", repoType: "dataset", repoId: "fixture/characters", manifestPath: "updates/style-a/stable.json" } as const
export const feed = { schemaVersion: 1, packId: "style-a", version: "1.0.1", minAppVersion: "0.7.2", runtime: { engine: "anime25d", assetApiVersion: 1, capabilities: ["hf-pack-updates-v1"] }, artifact: { path: "packs/style-a/1.0.1.petchar", revision: "a".repeat(40), bytes: 1024, sha256: "b".repeat(64) }, notes: "Plain text <script>never executed</script>" } as const
const bytes = (v: unknown) => Buffer.from(JSON.stringify(v))
describe("pack update metadata", () => {
  it("preserves old packs and requires both descriptor and capability", () => {
    const m = JSON.parse(packFiles()[0].data.toString())
    expect(parsePackManifest(bytes(m)).update).toBeUndefined()
    expect(() => parsePackManifest(bytes({ ...m, update: source }))).toThrow()
    m.runtime.capabilities.push("hf-pack-updates-v1")
    expect(() => parsePackManifest(bytes(m))).toThrow()
    expect(parsePackManifest(bytes({ ...m, update: source })).update).toEqual(source)
    expect(() => parsePackManifest(bytes({ ...m, update: { ...source, token: "secret" } }))).toThrow()
    expect(PACK_RUNTIME.capabilities).toContain("semantic-layer-swap")
  })
  it.each(["../x.json", "/x.json", "https://example.com/x.json", "x\\y.json", "x/%2e%2e/x.json", "x.json?q=x", "x.json#y", "x\n.json", "x//y.json", "x/./y.json"])("rejects unsafe source path %s", manifestPath => {
    expect(() => parseUpdateSource({ ...source, manifestPath })).toThrow("PACK_UPDATE_METADATA")
  })
  it.each(["x", "a/b/c", "a@b/c", "../c", "a/b?x", "a/%62", "a/b#x"])("rejects unsafe repository %s", repoId => expect(() => parseUpdateSource({ ...source, repoId })).toThrow())
  it("bounds and strictly validates feed shape, artifact and runtime", () => {
    expect(parseUpdateFeed(bytes(feed)).version).toBe("1.0.1")
    for (const patch of [{ version: "v5" }, { version: "1.0.0-beta" }, { minAppVersion: "0.7.2+test" }, { unknown: true }, { notes: "x".repeat(2001) }, { notes: "\u0000" }, { runtime: { ...feed.runtime, command: "run" } }, { artifact: { ...feed.artifact, revision: "main" } }, { artifact: { ...feed.artifact, bytes: 256 * 1024 ** 2 + 1 } }, { artifact: { ...feed.artifact, path: "packs/a.exe" } }]) expect(() => parseUpdateFeed(bytes({ ...feed, ...patch }))).toThrow()
    expect(() => parseUpdateFeed(Buffer.alloc(65537))).toThrow()
    expect(() => parseUpdateFeed(Buffer.from("<!doctype html>"))).toThrow()
    const future = parseUpdateFeed(bytes({ ...feed, runtime: { ...feed.runtime, capabilities: ["future-runtime"] } }))
    expect(supportsUpdateRuntime(future.runtime)).toBe(false)
  })
  it("keys the cache to the complete exact source, independent of property order", () => {
    expect(updateSourceKey("style-a", source)).toBe(updateSourceKey("style-a", { manifestPath: source.manifestPath, repoId: source.repoId, repoType: "dataset", provider: "huggingface", schemaVersion: 1 }))
    expect(updateSourceKey("style-a", source)).not.toBe(updateSourceKey("style-b", source))
    expect(updateSourceKey("style-a", source)).not.toBe(updateSourceKey("style-a", { ...source, repoId: "other/characters" }))
  })
})
