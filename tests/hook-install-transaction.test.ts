import { execFile } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { allEventSupport, hookHandler } from "../adapter/codex/hooks/HookInstallPlan.ts"
import { HookInstallTransaction, readHookTarget, type HookTransactionOptions, type InstallationBinding } from "../adapter/codex/hooks/HookInstallTransaction.ts"

const directories: string[] = [], installers: HookInstallTransaction[] = []
const desiredHandler = hookHandler({ mode: "development-node", executablePath: process.execPath, forwarderPath: resolve("adapter/codex/hooks/hook-forwarder.mjs"), dataDir: "/test/data", hookEndpoint: "http://127.0.0.1:4175/hook" })
const foreign = { type: "command", command: "echo PRIVATE_FOREIGN_TOKEN_CANARY", statusMessage: "PRIVATE_METADATA_CANARY" }
const original = JSON.stringify({ description: "PRIVATE_DESCRIPTION_CANARY", hooks: { Stop: [{ hooks: [foreign] }] }, extension: { preserved: true } })

async function fixture(before: string | null = original) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pet-transactions-")))
  directories.push(directory)
  const codexHome = join(directory, "codex"), storageRoot = join(directory, "private-installer"), target = join(codexHome, "hooks.json")
  await mkdir(codexHome, { mode: 0o700 })
  if (before !== null) await writeFile(target, before, { mode: 0o600 })
  const binding: InstallationBinding = { targetPath: target, hostFingerprint: "host-v1", configFingerprint: "config-v1", capabilityFingerprint: "capability-v1", targetVersion: "fixture-1", appVersion: "1", busy: false, blockers: [] }
  const make = (overrides: Partial<HookTransactionOptions> = {}) => {
    const installer = new HookInstallTransaction({ codexHome, storageRoot, context: { desiredHandler }, support: allEventSupport("supported"), getBinding: async () => structuredClone(binding), ...overrides })
    installers.push(installer)
    return installer
  }
  const installer = make()
  return { directory, codexHome, storageRoot, target, binding, installer, make }
}

afterEach(async () => {
  await Promise.all(installers.splice(0).map((installer) => installer.dispose()))
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("preview and protected transaction", () => {
  it("previews without files, applies once, and leaves exact reinstall/read status as a byte-preserving no-op", async () => {
    const f = await fixture(null)
    const preview = await f.installer.prepare("install", "window")
    expect(preview).toMatchObject({ canApply: true, foreignHandlersPreserved: 0 })
    expect(await readdir(f.codexHome)).toEqual([])
    expect(await readdir(f.directory)).toEqual(["codex"])
    expect(await f.installer.apply(preview.planId, "window")).toMatchObject({ status: "applied", changed: true })
    const before = await readFile(f.target, "utf8")
    const files = await readdir(f.storageRoot)
    await readHookTarget(f.codexHome)
    const noOp = await f.installer.prepare("install", "window")
    expect(await f.installer.apply(noOp.planId, "window")).toMatchObject({ status: "no-change", changed: false })
    expect(await readdir(f.storageRoot)).toEqual(files)
    expect(await readFile(f.target, "utf8")).toBe(before)
  })
  it("backs up exact original bytes with private permissions, preserving foreign settings without IPC leakage", async () => {
    const f = await fixture()
    await writeFile(join(f.codexHome, "config.toml"), "# PRIVATE_CONFIG_CANARY\n")
    const preview = await f.installer.prepare("install", "window")
    expect(JSON.stringify(preview)).not.toContain("PRIVATE_")
    expect(preview.foreignHandlersPreserved).toBe(1)
    const result = await f.installer.apply(preview.planId, "window")
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|before|after|backup|token/)
    const backup = join(f.storageRoot, `${preview.planId}.backup`)
    expect(await readFile(backup, "utf8")).toBe(original)
    expect((await stat(backup)).mode & 0o777).toBe(0o600)
    expect((await stat(f.storageRoot)).mode & 0o777).toBe(0o700)
    expect((await stat(f.target)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(f.target, "utf8")).hooks.Stop[0].hooks).toEqual([foreign])
    expect(await readFile(join(f.codexHome, "config.toml"), "utf8")).toBe("# PRIVATE_CONFIG_CANARY\n")
    const receipt = await readFile(join(f.storageRoot, `${preview.planId}.receipt.json`), "utf8")
    expect(receipt).not.toContain("PRIVATE_")
  })
  it("rejects external edits and same-byte inode replacements after approval", async () => {
    for (const replaceIdentity of [false, true]) {
      const f = await fixture()
      const preview = await f.installer.prepare("install", "window")
      if (replaceIdentity) {
        await writeFile(join(f.codexHome, "other"), original, { mode: 0o600 })
        await rename(join(f.codexHome, "other"), f.target)
      } else await writeFile(f.target, '{"changedBy":"user"}')
      const expected = await readFile(f.target, "utf8")
      await expect(f.installer.apply(preview.planId, "window")).rejects.toThrow("PLAN_STALE")
      expect(await readFile(f.target, "utf8")).toBe(expected)
      expect(await readdir(f.directory)).toEqual(["codex"])
    }
  })
  it("rejects a last-moment edit and cleans temporary files and locks", async () => {
    const f = await fixture()
    const installer = f.make({ phase: async (phase) => { if (phase === "before-rename") await writeFile(f.target, '{"changedBy":"editor"}') } })
    const preview = await installer.prepare("repair", "window")
    await expect(installer.apply(preview.planId, "window")).rejects.toThrow("PLAN_STALE")
    expect(await readFile(f.target, "utf8")).toBe('{"changedBy":"editor"}')
    expect(await readdir(f.codexHome)).toEqual(["hooks.json"])
  })
  it.each(["targetPath", "hostFingerprint", "configFingerprint", "capabilityFingerprint", "targetVersion", "appVersion"] as const)("invalidates a plan after %s changes", async (key) => {
    const f = await fixture()
    const preview = await f.installer.prepare("install", "window")
    f.binding[key] = "changed"
    await expect(f.installer.apply(preview.planId, "window")).rejects.toThrow("PLAN_STALE")
    expect(await readFile(f.target, "utf8")).toBe(original)
  })
  it("blocks a new active run without interrupting it", async () => {
    const f = await fixture()
    const preview = await f.installer.prepare("install", "window")
    f.binding.busy = true
    await expect(f.installer.apply(preview.planId, "window")).rejects.toThrow("ACTIVE_RUN")
    expect((await f.installer.prepare("install", "window")).conflicts).toContain("ACTIVE_RUN")
    expect(f.binding.busy).toBe(true)
  })
  it("rejects a different selected target during preview construction", async () => {
    const f = await fixture()
    f.binding.targetPath = join(f.directory, "another-home/hooks.json")
    await expect(f.installer.prepare("install", "window")).rejects.toThrow("PLAN_STALE")
    expect(await readFile(f.target, "utf8")).toBe(original)
  })
  it("binds approval to owner, one current plan and expiry; closing a window invalidates pending approval", async () => {
    const f = await fixture()
    let now = 0
    const installer = f.make({ now: () => now, planTtlMs: 50 })
    const preview = await installer.prepare("install", "window")
    await expect(installer.apply(preview.planId, "other-window")).rejects.toThrow("PLAN_OWNER_MISMATCH")
    now = 51
    await expect(installer.apply(preview.planId, "window")).rejects.toThrow("PLAN_EXPIRED")
    const second = await installer.prepare("install", "window")
    installer.invalidateOwner("window")
    await expect(installer.apply(second.planId, "window")).rejects.toThrow("PLAN_UNKNOWN")
    const superseded = await installer.prepare("install", "window")
    await installer.prepare("uninstall", "window")
    await expect(installer.apply(superseded.planId, "window")).rejects.toThrow("PLAN_UNKNOWN")
    expect(await readFile(f.target, "utf8")).toBe(original)
  })
  it("reuses a double-click's result and serializes two installer instances against one target", async () => {
    const f = await fixture(), other = f.make()
    const first = await f.installer.prepare("install", "one"), second = await other.prepare("install", "two")
    const applying = f.installer.apply(first.planId, "one")
    expect(f.installer.apply(first.planId, "one")).toBe(applying)
    await expect(other.apply(second.planId, "two")).rejects.toThrow("TARGET_BUSY")
    await expect(applying).resolves.toMatchObject({ status: "applied" })
    expect((await readdir(f.storageRoot)).filter((file) => file.endsWith(".backup"))).toHaveLength(1)
  })
  it("honors a cooperating live process lock and never deletes unknown locks", async () => {
    for (const lock of [JSON.stringify({ owner: "daemonlet-hook-installer", pid: process.pid }), "unknown lock"]) {
      const f = await fixture()
      const preview = await f.installer.prepare("install", "window")
      const path = join(f.codexHome, ".daemonlet-hooks.lock")
      await writeFile(path, lock, { mode: 0o600 })
      await expect(f.installer.apply(preview.planId, "window")).rejects.toThrow("TARGET_BUSY")
      expect(await readFile(path, "utf8")).toBe(lock)
      expect(await readFile(f.target, "utf8")).toBe(original)
    }
  })
  it("rejects symlink targets, replaced roots, unsafe permissions and malformed data", async () => {
    const f = await fixture(null)
    const destination = join(f.directory, "foreign.json")
    await writeFile(destination, original)
    await symlink(destination, f.target)
    await expect(f.installer.prepare("install", "window")).rejects.toThrow("UNSAFE_FILE")
    expect(await readFile(destination, "utf8")).toBe(original)
    const g = await fixture()
    const plan = await g.installer.prepare("install", "window")
    await rename(g.codexHome, `${g.codexHome}-old`)
    await mkdir(g.codexHome, { mode: 0o700 })
    await writeFile(g.target, original, { mode: 0o600 })
    await expect(g.installer.apply(plan.planId, "window")).rejects.toThrow("PLAN_STALE")
    for (const contents of ['{"hooks":{},"hooks":{}}', "{", "x".repeat(1024 * 1024 + 1)]) {
      const h = await fixture(contents)
      await expect(h.installer.prepare("install", "window")).rejects.toThrow()
      expect(await readFile(h.target, "utf8")).toBe(contents)
    }
    const readonly = await fixture()
    await chmod(readonly.target, 0o400)
    const locked = await readonly.installer.prepare("install", "window")
    await expect(readonly.installer.apply(locked.planId, "window")).rejects.toThrow("TARGET_NOT_WRITABLE")
    await chmod(readonly.target, 0o666)
    await expect(readonly.installer.prepare("install", "window")).rejects.toThrow("UNSAFE_FILE")
  })
  it("does not follow a symlinked receipt directory", async () => {
    const f = await fixture()
    await mkdir(join(f.directory, "outside"), { mode: 0o700 })
    await symlink(join(f.directory, "outside"), f.storageRoot)
    const plan = await f.installer.prepare("install", "window")
    expect(plan).toMatchObject({ canApply: false, conflicts: ["RECEIPT_RECOVERY_REQUIRED"] })
    expect(await readdir(join(f.directory, "outside"))).toEqual([])
  })
  it("rechecks expiry and private storage identity at the commit boundary", async () => {
    const f = await fixture()
    let now = 0
    const expiring = f.make({ now: () => now, planTtlMs: 100, phase: async (phase) => { if (phase === "before-rename") now = 101 } })
    const expiringPlan = await expiring.prepare("install", "window")
    await expect(expiring.apply(expiringPlan.planId, "window")).rejects.toThrow("PLAN_EXPIRED")
    expect(await readFile(f.target, "utf8")).toBe(original)
    const g = await fixture()
    const outside = join(g.directory, "outside")
    await mkdir(outside, { mode: 0o700 })
    const swapping = g.make({ phase: async (phase) => {
      if (phase !== "before-backup") return
      await rename(g.storageRoot, `${g.storageRoot}-original`)
      await symlink(outside, g.storageRoot)
    } })
    const swap = await swapping.prepare("install", "window")
    await expect(swapping.apply(swap.planId, "window")).rejects.toThrow("UNSAFE_DIRECTORY")
    expect(await readdir(outside)).toEqual([])
    expect(await readFile(g.target, "utf8")).toBe(original)
  })
  it.each(["before-backup", "before-temporary-write"] as const)("preserves the original on disk/backup failure at %s", async (failAt) => {
    const f = await fixture()
    const installer = f.make({ phase: async (phase) => { if (phase === failAt) throw new Error("ENOSPC") } })
    const preview = await installer.prepare("install", "window")
    await expect(installer.apply(preview.planId, "window")).rejects.toThrow("ENOSPC")
    expect(await readFile(f.target, "utf8")).toBe(original)
    expect(await readdir(f.codexHome)).toEqual(["hooks.json"])
    if (failAt === "before-temporary-write") expect((await f.installer.receipts()).recovery).toBe("not-committed")
  })
  it("refuses to overwrite an existing backup or commit without a successful backup", async () => {
    const f = await fixture()
    const preview = await f.installer.prepare("install", "window")
    await mkdir(f.storageRoot, { mode: 0o700 })
    const backup = join(f.storageRoot, `${preview.planId}.backup`)
    await writeFile(backup, "existing protected backup", { mode: 0o600 })
    await expect(f.installer.apply(preview.planId, "window")).rejects.toThrow("FILESYSTEM_ERROR")
    expect(await readFile(f.target, "utf8")).toBe(original)
    expect(await readFile(backup, "utf8")).toBe("existing protected backup")
  })
  it("reports a committed change despite receipt failure and recovers prepared receipts by actual file state", async () => {
    const f = await fixture()
    const installer = f.make({ phase: async (phase) => { if (phase === "before-receipt") throw new Error("ENOSPC") } })
    const preview = await installer.prepare("install", "window")
    expect(await installer.apply(preview.planId, "window")).toMatchObject({ status: "applied-with-receipt-warning", changed: true })
    const recovered = await f.installer.receipts()
    expect(recovered.recovery).toBe("committed")
    expect(recovered.last?.phase).toBe("prepared")
    expect(JSON.parse(await readFile(f.target, "utf8")).hooks.UserPromptSubmit).toHaveLength(1)
    const revert = await f.installer.prepare("revert-owned-change", "window")
    await f.installer.apply(revert.planId, "window")
    expect(JSON.parse(await readFile(f.target, "utf8"))).toEqual(JSON.parse(original))
  })
  it("does not roll back an editor's post-commit change and marks crash recovery as divergent", async () => {
    const f = await fixture()
    const changed = '{"externalChange":"keep after commit"}'
    const installer = f.make({ phase: async (phase) => { if (phase === "after-commit") await writeFile(f.target, changed) } })
    const preview = await installer.prepare("install", "window")
    expect(await installer.apply(preview.planId, "window")).toMatchObject({ status: "committed-conflict", changed: true })
    expect(await readFile(f.target, "utf8")).toBe(changed)
    expect((await f.installer.receipts()).recovery).toBe("diverged")
    expect((await f.installer.prepare("revert-owned-change", "window")).canApply).toBe(false)
  })
  it("reverts the last owned install while retaining third-party additions", async () => {
    const f = await fixture()
    const plan = await f.installer.prepare("install", "window")
    await f.installer.apply(plan.planId, "window")
    const later = JSON.parse(await readFile(f.target, "utf8"))
    later.hooks.Stop[0].hooks.push({ type: "command", command: "later foreign C" })
    later.newMetadata = 42
    await writeFile(f.target, JSON.stringify(later))
    const revert = await f.installer.prepare("revert-owned-change", "window")
    expect(revert.canApply).toBe(true)
    await f.installer.apply(revert.planId, "window")
    expect(JSON.parse(await readFile(f.target, "utf8"))).toEqual({ ...JSON.parse(original), newMetadata: 42, hooks: { Stop: [{ hooks: [foreign, { type: "command", command: "later foreign C" }] }] } })
  })
  it("keeps the native development CLI's dry-run/status/apply/uninstall isolated and redacted", async () => {
    const f = await fixture()
    for (const action of ["--dry-run", "--status", "--apply", "--uninstall"]) {
      const result = await promisify(execFile)(process.execPath, ["--no-warnings", "--experimental-strip-types", resolve("scripts/codex-hooks.ts"), action], { env: { ...process.env, CODEX_HOME: f.codexHome }, timeout: 5000 })
      expect(result.stderr).toBe("")
      expect(result.stdout).not.toContain("PRIVATE_")
    }
    expect(JSON.parse(await readFile(f.target, "utf8"))).toEqual(JSON.parse(original))
  })
})
