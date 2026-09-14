import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { allEventSupport, handlerIdentity, hookHandler } from "../adapter/codex/hooks/HookInstallPlan"
import { HookInstallTransaction, type HookTransactionOptions, type InstallationBinding } from "../adapter/codex/hooks/HookInstallTransaction"
import { hashText } from "../adapter/codex/hooks/HookLaunchSpec"
import { publicSetupError } from "../electron/main/CodexIntegrationController"

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return { ...actual, rename: vi.fn(actual.rename) }
})
const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
const roots: string[] = [], transactions: HookInstallTransaction[] = []
const handler = (version: string) => hookHandler({
  mode: "development-node", executablePath: "/fixture/node", forwarderPath: "/fixture/hook-forwarder.mjs",
  dataDir: `/fixture/${version}`, hookEndpoint: "http://127.0.0.1:4175/hook",
})
const oldHandler = handler("v1"), nextHandler = handler("v2")
const foreign = { type: "command", command: "echo PRIVATE_FOREIGN_CANARY" }
const original = JSON.stringify({ hooks: { Stop: [{ hooks: [foreign] }] } })
const edited = JSON.stringify({ note: "PRIVATE_METADATA_CANARY", hooks: { Stop: [{ hooks: [foreign] }] } })

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hook-abort-lifecycle-")))
  roots.push(root)
  const codexHome = join(root, "codex"), storageRoot = join(root, "receipts"), target = join(codexHome, "hooks.json")
  await mkdir(codexHome, { mode: 0o700 })
  await writeFile(target, original, { mode: 0o600 })
  const binding: InstallationBinding = { targetPath: target, hostFingerprint: "host", configFingerprint: "config", capabilityFingerprint: "fixture", targetVersion: "fixture", appVersion: "fixture", busy: false, blockers: [] }
  const make = (phase?: HookTransactionOptions["phase"], desiredHandler = oldHandler) => {
    const tx = new HookInstallTransaction({ codexHome, storageRoot, context: { desiredHandler }, support: allEventSupport("supported"), getBinding: async () => structuredClone(binding), phase })
    transactions.push(tx)
    return tx
  }
  const receiptPath = (id: string) => join(storageRoot, `${id}.receipt.json`)
  return { root, codexHome, storageRoot, target, binding, make, receiptPath, latestPath: join(storageRoot, `latest-${hashText(target)}.json`), lockPath: join(codexHome, ".daemonlet-hooks.lock") }
}

afterEach(async () => {
  vi.mocked(rename).mockImplementation(actualFs.rename)
  await Promise.allSettled(transactions.splice(0).map((tx) => tx.dispose()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe.runIf(process.platform !== "win32")("[POSIX filesystem] abort receipt durability and uncertain commit boundaries", () => {
  it("keeps a terminal abort as audit history without granting its uninstalled afterOwned any authority", async () => {
    const f = await fixture()
    const tx = f.make(async (phase) => { if (phase === "before-temporary-write") throw new Error("ENOSPC") }, nextHandler)
    const plan = await tx.prepare("install", "window")
    await expect(tx.apply(plan.planId, "window")).rejects.toThrow("ENOSPC")
    const record = JSON.parse(await readFile(f.receiptPath(plan.planId), "utf8"))
    expect(record).toMatchObject({ phase: "aborted-before-commit", previousReceiptId: null, abortedAt: expect.any(Number) })
    expect(record.inverse.afterOwned.length).toBeGreaterThan(0)
    expect((await stat(f.receiptPath(plan.planId))).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(f.latestPath, "utf8"))).toEqual({ id: plan.planId })
    expect(await readFile(join(f.storageRoot, `${plan.planId}.backup`), "utf8")).toBe(original)
    await tx.dispose()
    const later = JSON.stringify({ hooks: { Stop: [{ hooks: [foreign, nextHandler] }] } })
    await writeFile(f.target, later)
    const retry = f.make()
    expect(await retry.receipts()).toMatchObject({ recovery: "not-committed", identities: [], last: null })
    const uninstall = await retry.prepare("uninstall", "fresh-window")
    expect(uninstall.canApply).toBe(false)
    expect(uninstall.conflicts.some((code) => code.startsWith("AMBIGUOUS_HANDLER"))).toBe(true)
    expect(await readFile(f.target, "utf8")).toBe(later)
    expect(JSON.stringify(uninstall)).not.toContain("PRIVATE_")
    expect(await readdir(f.codexHome)).toEqual(["hooks.json"])
  })

  it("keeps a failed abort finalization prepared and refuses later divergence after recreation", async () => {
    const f = await fixture()
    const tx = f.make(async (phase) => {
      if (phase === "before-temporary-write") throw new Error("ENOSPC")
      if (phase === "before-abort-receipt") throw new Error("PRIVATE_DISK_ERROR_CANARY")
    })
    const plan = await tx.prepare("install", "window")
    const error = await tx.apply(plan.planId, "window").catch((value: unknown) => value)
    expect(publicSetupError(error)).toBe("ABORT_RECEIPT_WRITE_FAILED")
    expect(await readFile(f.target, "utf8")).toBe(original)
    expect(JSON.parse(await readFile(f.receiptPath(plan.planId), "utf8")).phase).toBe("prepared")
    await writeFile(f.target, edited)
    await tx.dispose()
    const retry = f.make()
    expect((await retry.receipts()).recovery).toBe("diverged")
    for (const action of ["install", "repair", "uninstall", "revert-owned-change"] as const) {
      const preview = await retry.prepare(action, "new-window")
      expect(preview.canApply).toBe(false)
      expect(preview.conflicts).toContain("RECEIPT_RECOVERY_REQUIRED")
    }
    expect(await readFile(f.target, "utf8")).toBe(edited)
  })

  it.each(["storage", "lock", "latest"] as const)("does not retire through a replaced %s or overwrite another owner's state", async (replacement) => {
    const f = await fixture()
    const outside = join(f.root, "outside"), previousStorage = join(f.root, "original-storage")
    const replacementPointer = JSON.stringify({ id: randomUUID() })
    const tx = f.make(async (phase) => {
      if (phase === "before-temporary-write") throw new Error("ENOSPC")
      if (phase !== "before-abort-receipt") return
      await writeFile(f.target, edited)
      if (replacement === "storage") {
        await rename(f.storageRoot, previousStorage)
        await mkdir(outside, { mode: 0o700 })
        await symlink(outside, f.storageRoot)
      } else if (replacement === "lock") {
        await unlink(f.lockPath)
        await writeFile(f.lockPath, "replacement owner", { mode: 0o600 })
      } else await writeFile(f.latestPath, replacementPointer)
    })
    const plan = await tx.prepare("install", "window")
    await expect(tx.apply(plan.planId, "window")).rejects.toThrow("ABORT_RECEIPT_WRITE_FAILED")
    expect(await readFile(f.target, "utf8")).toBe(edited)
    if (replacement === "storage") {
      expect(await readdir(outside)).toEqual([])
      expect((await f.make().receipts()).recovery).toBe("unavailable")
      await unlink(f.storageRoot)
      await rename(previousStorage, f.storageRoot)
    } else if (replacement === "lock") expect(await readFile(f.lockPath, "utf8")).toBe("replacement owner")
    else expect(await readFile(f.latestPath, "utf8")).toBe(replacementPointer)
    expect(JSON.parse(await readFile(f.receiptPath(plan.planId), "utf8")).phase).toBe("prepared")
    expect((await f.make().prepare("install", "new-window")).conflicts).toContain("RECEIPT_RECOVERY_REQUIRED")
  })

  it.each([false, true])("does not declare an abort when target rename rejects (filesystem changed: %s)", async (changed) => {
    const f = await fixture()
    vi.mocked(rename).mockImplementation(async (source, destination) => {
      if (destination !== f.target) return actualFs.rename(source, destination)
      if (changed) await actualFs.rename(source, destination)
      throw new Error("PRIVATE_RENAME_RESULT_UNCERTAIN")
    })
    const tx = f.make()
    const plan = await tx.prepare("install", "window")
    const error = await tx.apply(plan.planId, "window").catch((value: unknown) => value)
    expect(publicSetupError(error)).toBe("COMMIT_OUTCOME_UNKNOWN")
    const record = JSON.parse(await readFile(f.receiptPath(plan.planId), "utf8"))
    expect(record.phase).toBe("prepared")
    expect(record.abortedAt).toBeUndefined()
    const recovered = await f.make().receipts()
    expect(recovered.recovery).toBe(changed ? "committed" : "not-committed")
    if (changed) expect(recovered.last?.id).toBe(plan.planId)
    else {
      expect(await readFile(f.target, "utf8")).toBe(original)
      expect(recovered.identities).not.toContainEqual(handlerIdentity(oldHandler))
    }
    await writeFile(f.target, edited)
    expect((await f.make().receipts()).recovery).toBe("diverged")
    expect((await f.make().prepare("repair", "new-window")).canApply).toBe(false)
    expect(await readFile(f.target, "utf8")).toBe(edited)
  })

  it("preserves a previously confirmed commit with a receipt warning behind an aborted repair", async () => {
    const f = await fixture()
    const installedTx = f.make(async (phase) => { if (phase === "before-receipt") throw new Error("ENOSPC") })
    const installed = await installedTx.prepare("install", "window")
    expect(await installedTx.apply(installed.planId, "window")).toMatchObject({ status: "applied-with-receipt-warning" })
    const repairTx = f.make(async (phase) => {
      if (phase !== "before-rename") return
      const file = JSON.parse(await readFile(f.target, "utf8"))
      file.hooks.Stop[0].hooks.push({ type: "command", command: "echo later foreign" })
      await writeFile(f.target, JSON.stringify(file))
    }, nextHandler)
    const repair = await repairTx.prepare("repair", "window")
    await expect(repairTx.apply(repair.planId, "window")).rejects.toThrow("PLAN_STALE")
    await repairTx.dispose()
    const retry = f.make(undefined, nextHandler)
    const recovered = await retry.receipts()
    expect(recovered).toMatchObject({ recovery: "not-committed", last: { id: installed.planId, phase: "prepared" } })
    expect(recovered.identities).toContainEqual(handlerIdentity(oldHandler))
    expect(recovered.identities).not.toContainEqual(handlerIdentity(nextHandler))
    const uninstall = await retry.prepare("uninstall", "new-window")
    expect(uninstall.canApply).toBe(true)
    await retry.apply(uninstall.planId, "new-window")
    expect(JSON.parse(await readFile(f.target, "utf8")).hooks).toEqual({ Stop: [{ hooks: [foreign, { type: "command", command: "echo later foreign" }] }] })
  })
})
