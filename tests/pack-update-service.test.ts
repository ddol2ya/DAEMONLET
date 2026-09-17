import { afterEach, describe, expect, it, vi } from "vitest"
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CharacterRegistry } from "../electron/main/CharacterRegistry"
import { extractCharacterPack } from "../electron/main/CharacterPackArchive"
import { validatePackDirectory, sha256 } from "../electron/main/CharacterPackAssets"
import { PackUpdateService } from "../electron/main/pack-updates/PackUpdateService"
import { HuggingFacePackProvider, HfRateError } from "../electron/main/pack-updates/HuggingFacePackProvider"
import { PackUpdatePreferences } from "../electron/main/pack-updates/PackUpdatePreferences"
import { PACK_RUNTIME } from "../electron/shared/character-pack-contract"
import { type PackUpdateFeed, type PackUpdateSource } from "../electron/shared/pack-update-contract"
import { setApplicationInputLocked } from "../electron/main/updates/OperationGate"
import { builtinFixture, writePack } from "./helpers/character-pack"

const roots: string[] = [], services: PackUpdateService[] = [], registries: CharacterRegistry[] = []
afterEach(async () => { setApplicationInputLocked(false); for (const s of services.splice(0)) await s.dispose(); for (const r of registries.splice(0)) await r.dispose(); await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))) })
const sourceFor = (id: string): PackUpdateSource => ({ schemaVersion: 1, provider: "huggingface", repoType: "dataset", repoId: "fixture/characters", manifestPath: `updates/${id}/stable.json` })
const runtime = { ...PACK_RUNTIME, capabilities: PACK_RUNTIME.capabilities.filter(c => c !== "side-chat-persona-v1") }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pack-updates-")); roots.push(root)
  let validationHold: (() => Promise<void>) | undefined
  const registry = new CharacterRegistry(join(root, "data"), await builtinFixture(join(root, "builtin")), async (request, signal) => {
    if (request.kind === "archive") await validationHold?.()
    signal?.throwIfAborted()
    return request.kind === "archive" ? extractCharacterPack(request.path, request.transactionRoot!) : validatePackDirectory(request.path)
  }); registries.push(registry); await registry.initialize()
  const source = sourceFor("style-a"), archives = new Map<string, string>()
  const install = async (id: string, version = "1.0.0", update: PackUpdateSource | null = sourceFor(id)) => {
    const path = await writePack(join(root, "inputs"), { id, version, extra: update ? { update, runtime } : {} })
    const p = await registry.prepareImport(path, "seed"); await registry.commitImport(p.token, "seed"); return path
  }
  for (const id of ["style-a", "style-b", "style-c"]) await install(id)
  const next = await writePack(join(root, "inputs"), { id: "style-a", version: "1.0.1", extra: { update: source, runtime } })
  const bytes = await readFile(next)
  let feed: PackUpdateFeed = { schemaVersion: 1, packId: "style-a", version: "1.0.1", minAppVersion: "0.7.2", runtime, artifact: { path: "packs/style-a/1.0.1.petchar", revision: "a".repeat(40), bytes: bytes.length, sha256: sha256(bytes) }, notes: "Metadata only" }
  archives.set(feed.artifact.sha256, next)
  const provider = { feed: vi.fn(async () => ({ feed: structuredClone(feed), notModified: false, etag: '"a"' })), download: vi.fn(async (_s: PackUpdateSource, f: PackUpdateFeed, target: string, signal: AbortSignal, progress: (r: number) => void) => { signal.throwIfAborted(); await copyFile(archives.get(f.artifact.sha256)!, target); progress(f.artifact.bytes) }) }
  let owner: string | null = "window-1", canApply = true, now = Date.now(), active = "style-b", failLoad = false
  const preferences = new PackUpdatePreferences(join(root, "preferences.json"))
  const apply = vi.fn(async (p, own) => { const e = await registry.commitImport(p.token, own); if (failLoad) { await registry.rollback(e); throw Error("PACK_LOAD") } })
  const options = { registry, dataRoot: join(root, "data"), appVersion: "0.7.2", provider: provider as unknown as HuggingFacePackProvider, preferences, owner: () => owner, selected: () => active, canApply: () => canApply, apply, changed: vi.fn(), now: () => now }
  const service = new PackUpdateService(options); services.push(service); await service.start()
  return { root, registry, service, provider, preferences, source, next, install, options, apply, archives,
    state: () => service.snapshot().find(s => s.packId === "style-a")!, feed: () => feed, setFeed: (f: PackUpdateFeed) => { feed = f }, advance: () => { now += 86400_000 }, setOwner: (v: string | null) => { owner = v }, setCanApply: (v: boolean) => { canApply = v }, setFailLoad: () => { failLoad = true }, setActive: (id: string) => { active = id }, active: () => active,
    holdValidation: (hold: () => Promise<void>) => { validationHold = hold },
  }
}
describe("pack update transactions", () => {
  it.each(["source", "feed", "update", "auto", "skip"] as const)("settles owned %s metadata work before disposal completes", async phase => {
    const f = await fixture(); let release!: () => void
    const hold = () => new Promise<void>(resolve => { release = resolve })
    if (phase !== "source") { await f.service.check("style-a", "window-1"); f.advance() }
    if (phase === "source") {
      const save = f.preferences.save.bind(f.preferences)
      vi.spyOn(f.preferences, "save").mockImplementationOnce(async value => { await hold(); await save(value) })
    } else if (phase === "feed") {
      const feed = f.provider.feed.getMockImplementation()!
      f.provider.feed.mockImplementationOnce(async () => { await hold(); return feed() })
    } else {
      const update = f.preferences.update.bind(f.preferences)
      vi.spyOn(f.preferences, "update").mockImplementationOnce(async (...args) => { await update(...args); await hold() })
    }
    const work = phase === "auto" ? f.service.auto("style-a", true, "window-1") : phase === "skip" ? f.service.skip("style-a", "window-1") : f.service.check("style-a", "window-1")
    await vi.waitFor(() => expect(release).toBeTypeOf("function"))
    let disposed = false
    const disposing = f.service.dispose().then(() => { disposed = true })
    try { await new Promise<void>(resolve => setImmediate(resolve)); expect(disposed).toBe(false) }
    finally { release(); await work; await disposing }
    if (phase === "auto") expect(f.preferences.get("style-a", f.source)?.autoCheck).toBe(true)
    if (phase === "skip") expect(f.preferences.get("style-a", f.source)?.skipped).toBe("1.0.1")
  })
  it("awaits initialization without subscribing or scheduling after disposal", async () => {
    const f = await fixture(); let release!: () => void
    vi.spyOn(f.preferences, "load").mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
    const subscribe = vi.spyOn(f.registry, "subscribe"), late = new PackUpdateService(f.options)
    services.push(late)
    const starting = late.start(); await vi.waitFor(() => expect(release).toBeTypeOf("function"))
    let disposed = false
    const disposing = late.dispose().then(() => { disposed = true })
    try { await new Promise<void>(resolve => setImmediate(resolve)); expect(disposed).toBe(false) }
    finally { release(); await starting; await disposing }
    expect(subscribe).not.toHaveBeenCalled()
    expect(late.snapshot()).toEqual([])
  })
  it.each([false, true])("awaits active application and disk cleanup during disposal (failure=%s)", async failure => {
    const f = await fixture(); let release!: () => void
    f.apply.mockImplementation(async (preview, owner) => {
      const entry = await f.registry.commitImport(preview.token, owner)
      await new Promise<void>(resolve => { release = resolve })
      if (failure) { await f.registry.rollback(entry); throw Error("PACK_LOAD") }
    })
    await f.service.check("style-a", "window-1"); await f.service.download("style-a", "window-1")
    const application = f.service.apply(f.state().candidateId!, "window-1").then(() => null, error => error)
    await vi.waitFor(() => expect(release).toBeTypeOf("function"))
    let disposed = false
    const disposing = f.service.dispose().then(() => { disposed = true })
    try {
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(disposed).toBe(false)
    } finally { release(); await disposing; await application }
    expect(f.service.applying()).toBe(false)
    expect(await readdir(join(f.root, "data/pack-update-transactions"))).toEqual([])
    expect(await readdir(join(f.root, "data/characters/staging"))).toEqual([])
    expect(f.registry.get("style-a")?.version).toBe(failure ? "1.0.0" : "1.0.1")
  })
  it.each([false, true])("publishes the released apply owner after success or recovery (failure=%s)", async failure => {
    const f = await fixture()
    if (failure) f.setFailLoad()
    const locks: boolean[] = []
    f.options.changed.mockImplementation(() => { locks.push(f.service.applying()) })
    await f.service.check("style-a", "window-1"); await f.service.download("style-a", "window-1")
    const result = f.service.apply(f.state().candidateId!, "window-1")
    if (failure) await expect(result).rejects.toThrow("PACK_LOAD")
    else await result
    expect(locks).toContain(true)
    expect(f.service.applying()).toBe(false)
    // Cached native menus subscribe to changes; a silent release leaves their
    // last lock snapshot true even though the service has finished applying.
    expect(locks.at(-1)).toBe(false)
  })
  it("keeps HF validation alive when the old page cancels its document's local import", async () => {
    const f = await fixture(); await f.service.check("style-a", "window-1")
    let release!: () => void
    f.holdValidation(() => new Promise<void>(resolve => { release = resolve }))
    const download = f.service.download("style-a", "window-1")
    await vi.waitFor(() => expect(release).toBeTypeOf("function"))
    expect(f.state().phase).toBe("verifying")
    // The old CharacterPacks unmount used this same document owner, including
    // when it had never opened a local picker. It must not own an HF operation.
    await f.registry.cancelImport("window-1")
    release(); await download
    expect(f.state()).toMatchObject({ phase: "ready", candidateId: expect.any(String) })
    expect(f.registry.get("style-a")?.version).toBe("1.0.0")
    await f.service.apply(f.state().candidateId!, "window-1")
    expect(f.registry.get("style-a")?.version).toBe("1.0.1")
  })
  it("still cancels the HF Worker transaction when the document is retired", async () => {
    const f = await fixture(); await f.service.check("style-a", "window-1")
    let release!: () => void
    f.holdValidation(() => new Promise<void>(resolve => { release = resolve }))
    const download = f.service.download("style-a", "window-1")
    await vi.waitFor(() => expect(release).toBeTypeOf("function"))
    f.setOwner(null)
    const cancelled = f.service.cancel("window-1")
    release(); await Promise.all([download, cancelled])
    expect(f.registry.get("style-a")?.version).toBe("1.0.0")
    expect(f.registry.readyForUpdate()).toBe(true)
    expect(f.service.readyForUpdate()).toBe(true)
    expect(await readdir(join(f.root, "data/characters/staging"))).toEqual([])
    expect(await readdir(join(f.root, "data/pack-update-transactions"))).toEqual([])
  })
  it("makes zero requests on install, selection, restart or automatic checks off", async () => {
    const f = await fixture(); await f.install("legacy", "1.0.0", null); await f.service.background()
    expect(f.provider.feed).not.toHaveBeenCalled(); expect(f.provider.download).not.toHaveBeenCalled()
    expect(f.service.snapshot().some(s => s.packId === "legacy" || s.packId === "gpichan")).toBe(false)
    await expect(f.service.check("gpichan", "window-1")).rejects.toThrow("PACK_UPDATE_SOURCE")
  })
  it("updates only the same independent ID through prepare/commit, preserves selection, and restores after restart", async () => {
    const f = await fixture(), b = f.registry.get("style-b"), c = f.registry.get("style-c")
    await f.service.check("style-a", "window-1"); expect(f.state().phase).toBe("available")
    await f.service.download("style-a", "window-1"); expect(f.state().phase).toBe("ready")
    expect(f.service.readyForUpdate()).toBe(false); expect(f.registry.get("style-a")?.version).toBe("1.0.0")
    await f.service.apply(f.state().candidateId!, "window-1")
    expect(f.state().phase).toBe("applied"); expect(f.registry.get("style-a")?.version).toBe("1.0.1")
    expect(f.registry.get("style-b")).toEqual(b); expect(f.registry.get("style-c")).toEqual(c); expect(f.active()).toBe("style-b")
    expect(f.service.readyForUpdate()).toBe(true)
    await f.registry.rollback(f.registry.get("style-a")!)
    const restart = new CharacterRegistry(join(f.root, "data"), join(f.root, "builtin"), async request => validatePackDirectory(request.path))
    registries.push(restart); await restart.initialize(); expect(restart.get("style-a")?.version).toBe("1.0.0")
    expect(f.provider.download).toHaveBeenCalledOnce()
  })
  it("rejects another appearance's feed or archive, source changes and runtime mismatch", async () => {
    for (const scenario of ["feed", "archive", "source", "runtime"]) {
      const f = await fixture(), original = f.registry.get("style-a")
      if (scenario === "feed") f.setFeed({ ...f.feed(), packId: "style-b" })
      else if (scenario !== "runtime") {
        const bad = await writePack(join(f.root, "bad"), { id: scenario === "archive" ? "style-b" : "style-a", version: "1.0.1", extra: { runtime, update: scenario === "source" ? { ...f.source, repoId: "different/characters" } : f.source } })
        f.archives.set(f.feed().artifact.sha256, bad)
      } else f.setFeed({ ...f.feed(), runtime: { ...runtime, capabilities: ["hf-pack-updates-v1"] } })
      await f.service.check("style-a", "window-1")
      if (scenario !== "feed") await f.service.download("style-a", "window-1")
      expect(f.state().phase).toBe("error"); expect(f.registry.get("style-a")).toEqual(original); expect(f.apply).not.toHaveBeenCalled()
    }
  })
  it("handles 304 without cache by retrying once, and rejects conflicting bytes for the same version", async () => {
    const f = await fixture()
    f.provider.feed.mockResolvedValueOnce({ notModified: true } as any)
    await f.service.check("style-a", "window-1"); expect(f.provider.feed).toHaveBeenCalledTimes(2)
    f.advance(); f.setFeed({ ...f.feed(), artifact: { ...f.feed().artifact, sha256: "d".repeat(64) } })
    await f.service.check("style-a", "window-1"); expect(f.state().error).toBe("PACK_CONFLICT")
  })
  it("never downgrades or downloads an incompatible future runtime", async () => {
    const f = await fixture()
    for (const patch of [{ version: "0.9.9" }, { minAppVersion: "9.0.0" }, { runtime: { ...runtime, capabilities: ["future"] } }]) {
      f.advance(); f.setFeed({ ...f.feed(), ...patch }); await f.service.check("style-a", "window-1")
      await expect(f.service.download("style-a", "window-1")).rejects.toThrow("PACK_INCOMPATIBLE")
      expect(f.registry.get("style-a")?.version).toBe("1.0.0")
    }
  })
  it("ignores late download completion after cancel, owner close, removal or local update", async () => {
    for (const mode of ["cancel", "owner", "remove", "local"]) {
      const f = await fixture(); let release!: () => void
      const download = f.provider.download.getMockImplementation()!
      f.provider.download.mockImplementation(async (...args) => { await new Promise<void>(r => { release = r }); await download(...args) })
      await f.service.check("style-a", "window-1")
      const task = f.service.download("style-a", "window-1"); await vi.waitFor(() => expect(release).toBeTypeOf("function"))
      let cancelled: Promise<void> | undefined
      if (mode === "cancel") cancelled = f.service.cancel("window-1")
      if (mode === "owner") { f.setOwner(null); cancelled = f.service.cancel("window-1") }
      if (mode === "remove") await f.registry.remove(f.registry.get("style-a")!)
      if (mode === "local") await f.install("style-a", "1.0.2")
      release(); await task; await cancelled
      expect(f.state()?.candidateId).toBeUndefined(); expect(f.apply).not.toHaveBeenCalled()
      expect(await readdir(join(f.root, "data/pack-update-transactions"))).toEqual([])
    }
  })
  it("defers active chat/transition application and blocks app shutdown until cancelled", async () => {
    const f = await fixture(); await f.service.check("style-a", "window-1"); await f.service.download("style-a", "window-1")
    f.setCanApply(false)
    await expect(f.service.apply(f.state().candidateId!, "window-1")).rejects.toThrow("PACK_UPDATE_CHAT_BUSY")
    expect(f.apply).not.toHaveBeenCalled(); expect(f.state().phase).toBe("ready")
    setApplicationInputLocked(true)
    await expect(f.service.apply(f.state().candidateId!, "window-1")).rejects.toThrow("PACK_TRANSACTION")
    await f.service.cancel("window-1"); expect(f.service.readyForUpdate()).toBe(true)
  })
  it("does not report rendering success when active preparation restores the previous revision", async () => {
    const f = await fixture(); f.setActive("style-a"); f.setFailLoad()
    await f.service.check("style-a", "window-1"); await f.service.download("style-a", "window-1")
    await expect(f.service.apply(f.state().candidateId!, "window-1")).rejects.toThrow("PACK_LOAD")
    expect(f.state().phase).toBe("error"); expect(f.registry.get("style-a")?.version).toBe("1.0.0")
  })
  it("stays applying between registry commit and the renderer-ready result", async () => {
    const f = await fixture(); let ready!: () => void
    f.apply.mockImplementation(async (p, owner) => { await f.registry.commitImport(p.token, owner); await new Promise<void>(r => { ready = r }) })
    await f.service.check("style-a", "window-1"); await f.service.download("style-a", "window-1")
    const applying = f.service.apply(f.state().candidateId!, "window-1")
    await vi.waitFor(() => expect(ready).toBeTypeOf("function"))
    expect(f.registry.get("style-a")?.version).toBe("1.0.1")
    expect(f.state().phase).toBe("applying"); expect(f.service.readyForUpdate()).toBe(false)
    ready(); await applying; expect(f.state().phase).toBe("applied")
  })
  it("binds candidates to owner and expiration, and never lets another owner apply", async () => {
    const f = await fixture(); await f.service.check("style-a", "window-1"); await f.service.download("style-a", "window-1")
    const id = f.state().candidateId!
    await expect(f.service.apply(id, "window-2")).rejects.toThrow("PACK_TRANSACTION")
    f.advance(); await expect(f.service.apply(id, "window-1")).rejects.toThrow("PACK_TRANSACTION")
    expect(f.apply).not.toHaveBeenCalled()
  })
  it("persists source consent, skip and default-off preferences, and honors rate backoff", async () => {
    const f = await fixture(); await f.service.check("style-a", "window-1"); await f.service.skip("style-a", "window-1")
    expect(f.state().phase).toBe("skipped")
    const prefs = new PackUpdatePreferences(join(f.root, "preferences.json")); await prefs.load()
    expect(prefs.get("style-a", f.source)).toMatchObject({ autoCheck: false, skipped: "1.0.1" })
    expect(prefs.get("style-a", { ...f.source, repoId: "other/characters" })).toBeUndefined()
    f.advance(); f.provider.feed.mockRejectedValueOnce(new HfRateError(120_000)); await f.service.check("style-a", "window-1")
    expect(f.state().error).toBe("PACK_UPDATE_RATE")
    await expect(f.service.check("style-a", "window-1")).rejects.toThrow("PACK_UPDATE_RATE")
  })
  it("invalidates a background response immediately when auto checking is disabled", async () => {
    const f = await fixture(); await f.service.check("style-a", "window-1"); await f.service.auto("style-a", true, "window-1"); f.advance()
    let release!: (value: any) => void
    f.provider.feed.mockImplementationOnce(() => new Promise(r => { release = r }))
    const check = f.service.background(); await vi.waitFor(() => expect(release).toBeTypeOf("function"))
    await f.service.auto("style-a", false, "window-1"); release({ feed: { ...f.feed(), version: "1.0.2" }, notModified: false }); await check
    expect(f.state().phase).toBe("idle"); expect(f.state().autoCheck).toBe(false)
    expect(f.preferences.get("style-a", f.source)?.feed?.version).toBe("1.0.1")
  })
})
