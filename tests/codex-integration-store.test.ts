import { afterEach, expect, it } from "vitest"
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { CodexIntegrationStore, defaultIntegrationSettings } from "../electron/main/CodexIntegrationStore"
import { MAX_HOOK_FILE_BYTES } from "../adapter/codex/hooks/HookJson"

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "integration-store-"))); roots.push(root)
  const userData = join(root, "profile"); await mkdir(userData, { mode: 0o700 })
  return { root, userData, store: new CodexIntegrationStore(userData) }
}
it("persists repeated onboarding changes and reloads on the native filesystem", async () => {
  const { store, userData } = await fixture()
  expect((await store.load()).issue).toBeNull()
  await store.save({ ...store.get(), onboarding: "shown" })
  await store.save({ ...store.get(), onboarding: "skipped" })
  const reopened = new CodexIntegrationStore(userData)
  expect(await reopened.load()).toEqual({ issue: null, value: { ...defaultIntegrationSettings(), onboarding: "skipped" } })
  await reopened.save({ ...reopened.get(), onboarding: "acknowledged" })
  expect(JSON.parse(await readFile(store.path, "utf8")).onboarding).toBe("acknowledged")
})
it.each(["{", '{"version":99}', "x".repeat(MAX_HOOK_FILE_BYTES + 1)])("preserves unreadable or newer settings (%#)", async contents => {
  const { store } = await fixture()
  await writeFile(store.path, contents, { mode: 0o600 })
  expect((await store.load()).issue).toBe("INTEGRATION_STORE_UNREADABLE")
  await expect(store.save(defaultIntegrationSettings())).rejects.toThrow("INTEGRATION_STORE_UNREADABLE")
  expect(await readFile(store.path, "utf8")).toBe(contents)
})
it("refuses to overwrite an independent edit after loading", async () => {
  const { store } = await fixture(); await store.load()
  const foreign = JSON.stringify({ ...defaultIntegrationSettings(), onboarding: "acknowledged" })
  await writeFile(store.path, foreign, { mode: 0o600 })
  await expect(store.save({ ...store.get(), onboarding: "skipped" })).rejects.toThrow("INTEGRATION_STORE_CHANGED")
  expect(await readFile(store.path, "utf8")).toBe(foreign)
})
it.each(["symlink", "hardlink", "directory-link"])("refuses %s settings without changing the target", async kind => {
  const { root, store, userData } = await fixture()
  const foreignDir = join(root, "foreign"); await mkdir(foreignDir)
  const foreign = join(foreignDir, "codex-integration.json"), content = JSON.stringify(defaultIntegrationSettings())
  await writeFile(foreign, content, { mode: 0o600 })
  if (kind === "symlink") await symlink(foreign, store.path)
  else if (kind === "hardlink") await link(foreign, store.path)
  else { await rm(userData, { recursive: true }); await symlink(foreignDir, userData, process.platform === "win32" ? "junction" : "dir") }
  expect((await store.load()).issue).toBe("INTEGRATION_STORE_UNREADABLE")
  await expect(store.save(defaultIntegrationSettings())).rejects.toThrow("INTEGRATION_STORE_UNREADABLE")
  expect(await readFile(foreign, "utf8")).toBe(content)
})
