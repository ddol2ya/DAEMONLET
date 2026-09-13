import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { CharacterRegistry } from "../electron/main/CharacterRegistry"
import { validatePackDirectory } from "../electron/main/CharacterPackAssets"
import { extractCharacterPack } from "../electron/main/CharacterPackArchive"
import { builtinFixture, writePack } from "./helpers/character-pack"
import type { PackValidator } from "../electron/main/CharacterPackWorker"
import { normalizeDesktopSettings, validateDesktopSettingsPatch } from "../electron/shared/desktop-settings"
import { isCharacterId } from "../electron/shared/character-pack-contract"

const roots: string[] = [], registries: CharacterRegistry[] = []
const validator: PackValidator = task => task.kind === "archive" ? extractCharacterPack(task.path, task.transactionRoot!) : validatePackDirectory(task.path, { rig: task.rig })
afterEach(async () => { await Promise.all(registries.splice(0).map(r => r.dispose())); await Promise.all(roots.splice(0).map(r => rm(r, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "registry-test-")); roots.push(root)
  const builtin = await builtinFixture(join(root, "builtin")), user = join(root, "user")
  const registry = new CharacterRegistry(user, builtin, validator); registries.push(registry); await registry.initialize()
  return { root, builtin, user, registry, reopen: async () => { const r = new CharacterRegistry(user, builtin, validator); registries.push(r); await r.initialize(); return r } }
}

describe("character registry transactions", () => {
  it("defers archived rig decoding, protects old assets, and validates before rollback", async () => {
    const f = await fixture()
    const first = await f.registry.prepareImport(await writePack(f.root), "owner")
    const old = await f.registry.commitImport(first.token, "owner")
    const second = await f.registry.prepareImport(await writePack(f.root, {version:"2.0.0", color:90}), "owner")
    const current = await f.registry.commitImport(second.token, "owner")
    const checked = vi.fn(validator)
    const reopened = new CharacterRegistry(f.user, f.builtin, checked); registries.push(reopened)
    await reopened.initialize()
    expect(checked.mock.calls.map(([task]) => task.rig)).toEqual([false, true])
    expect(reopened.get(current.id)?.previousVersion).toBe("1.0.0")
    expect(await reopened.resolveAsset(old.id, old.revision, "model.psd")).toBeNull()
    await reopened.rollback({id:current.id, revision:current.revision})
    expect(checked.mock.calls.at(-1)?.[0].rig).toBeUndefined()
    expect(await reopened.resolveAsset(old.id, old.revision, "model.psd")).toBeTruthy()
  })

  it("installs staged bytes independently of the source, restores selection, updates and rolls back", async () => {
    const f = await fixture(), archive = await writePack(f.root)
    const preview = await f.registry.prepareImport(archive, "window-1")
    expect(preview.kind).toBe("install"); expect(f.registry.get("fresh-character")).toBeUndefined()
    await writeFile(archive, "original was moved/changed")
    const entry = await f.registry.commitImport(preview.token, "window-1")
    expect(entry.source).toBe("external"); expect(JSON.stringify(f.registry.snapshot())).not.toContain(f.user)
    expect(normalizeDesktopSettings({ characterId: entry.id }, isCharacterId).value.characterId).toBe(entry.id)
    expect(validateDesktopSettingsPatch({ characterId: entry.id }, f.registry.isAvailable)?.characterId).toBe(entry.id)
    expect(validateDesktopSettingsPatch({ characterId: "unknown" }, f.registry.isAvailable)).toBeNull()
    const loaded = await f.reopen(); expect(loaded.get(entry.id)?.revision).toBe(entry.revision)
    const v2 = await writePack(f.root, { version: "2.0.0", color: 90 })
    const next = await loaded.prepareImport(v2, "window-1"); expect(next.kind).toBe("update")
    const updated = await loaded.commitImport(next.token, "window-1")
    expect(updated.revision).not.toBe(entry.revision); expect(updated.previousVersion).toBe("1.0.0")
    await loaded.rollback({ id: updated.id, revision: updated.revision })
    expect(loaded.get(entry.id)?.revision).toBe(entry.revision)
    await expect(loaded.commitImport(next.token, "window-1")).rejects.toThrow("PACK_TRANSACTION")
  })
  it("rejects builtin replacement, version conflicts, downgrades and forged transaction ownership", async () => {
    const f = await fixture()
    await expect(f.registry.prepareImport(await writePack(f.root, { id: "gpichan" }), "owner")).rejects.toThrow("PACK_BUILTIN")
    const preview = await f.registry.prepareImport(await writePack(f.root, { version: "2.0.0" }), "owner")
    await expect(f.registry.commitImport(preview.token, "impostor")).rejects.toThrow("PACK_TRANSACTION")
    const entry = await f.registry.commitImport(preview.token, "owner")
    const same = await f.registry.prepareImport(await writePack(f.root, { version: "2.0.0" }), "owner")
    expect(same.kind).toBe("installed"); await f.registry.commitImport(same.token, "owner")
    await expect(f.registry.prepareImport(await writePack(f.root, { version: "2.0.0", color: 3 }), "owner")).rejects.toThrow("PACK_CONFLICT")
    await expect(f.registry.prepareImport(await writePack(f.root, { version: "1.0.0" }), "owner")).rejects.toThrow("PACK_DOWNGRADE")
    expect(f.registry.get(entry.id)?.revision).toBe(entry.revision)
  })
  it("cancels a validated preview without publishing and invalidates its token", async () => {
    const f = await fixture(), preview = await f.registry.prepareImport(await writePack(f.root), "owner")
    await f.registry.cancelImport("owner")
    await expect(f.registry.commitImport(preview.token, "owner")).rejects.toThrow("PACK_TRANSACTION")
    expect(f.registry.snapshot().entries).toHaveLength(1)
  })
  it("serves only registered revision inventory and rejects symlinks", async () => {
    const f = await fixture(), p = await f.registry.prepareImport(await writePack(f.root), "owner"), e = await f.registry.commitImport(p.token, "owner")
    expect(await f.registry.resolveAsset(e.id, e.revision, "character.json")).toBeTruthy()
    for (const path of ["pack.json", "registry.json", "../desktop-settings.json", "not-listed.json"]) expect(await f.registry.resolveAsset(e.id, e.revision, path)).toBeNull()
    expect(await f.registry.resolveAsset("another-pack", e.revision, "character.json")).toBeNull()
    const path = (await f.registry.resolveAsset(e.id, e.revision, "rig.json"))!
    await rm(path); await symlink(join(f.builtin, "catalog.json"), path)
    expect(await f.registry.resolveAsset(e.id, e.revision, "rig.json")).toBeNull()
  })
  it("isolates one corrupt pack and preserves unknown user files when removing", async () => {
    const f = await fixture(), p = await f.registry.prepareImport(await writePack(f.root), "owner"), e = await f.registry.commitImport(p.token, "owner")
    const root = join(f.user, "characters/packs", e.id, "revisions", e.revision)
    await writeFile(join(root, "my-note.txt"), "user-owned note")
    const loaded = await f.reopen()
    expect(loaded.get(e.id)?.status).toBe("disabled"); expect(loaded.get("gpichan")?.status).toBe("ready")
    await loaded.remove({ id: e.id, revision: e.revision })
    expect(await readFile(join(root, "my-note.txt"), "utf8")).toBe("user-owned note")
    expect(loaded.get(e.id)).toBeUndefined()
  })
  it("recovers the previous committed index and never discovers orphan revisions", async () => {
    const f = await fixture(), p = await f.registry.prepareImport(await writePack(f.root), "owner"), e = await f.registry.commitImport(p.token, "owner")
    const p2 = await f.registry.prepareImport(await writePack(f.root, { version: "2.0.0" }), "owner"); await f.registry.commitImport(p2.token, "owner")
    await writeFile(join(f.user, "characters/registry.json"), "half written")
    await mkdir(join(f.user, "characters/packs/orphan/revisions", "e".repeat(64)), { recursive: true })
    const restored = await f.reopen()
    expect(restored.get(e.id)?.revision).toBe(e.revision)
    expect(restored.snapshot().warning).toContain("복원")
    expect(restored.get("orphan")).toBeUndefined()
  })
})
