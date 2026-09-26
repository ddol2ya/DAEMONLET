import { afterEach, expect, it } from "vitest"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HookInstallTransaction, type TransactionPhase } from "../adapter/codex/hooks/HookInstallTransaction"
import { hashText } from "../adapter/codex/hooks/HookLaunchSpec"
import { allEventSupport } from "../adapter/codex/hooks/HookInstallPlan"

const roots: string[] = [], transactions: HookInstallTransaction[] = []
afterEach(async () => { await Promise.all(transactions.splice(0).map(t => t.dispose())); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture(phase?: (phase: TransactionPhase, target: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hook-platform-"))); roots.push(root)
  const home = join(root, "home"), user = join(root, "user"), storageRoot = join(user, "receipts"), target = join(home, "hooks.json")
  await mkdir(home, { mode: 0o700 }); await mkdir(user, { mode: 0o700 })
  const foreign = { hooks: { Stop: [{ hooks: [{ type: "command", command: "foreign-handler", timeout: 1 }] }] } }
  await writeFile(target, JSON.stringify(foreign), { mode: 0o600 })
  const transaction = new HookInstallTransaction({ codexHome: home, storageRoot,
    context: { desiredHandler: { type: "command", command: "fixture-app-handler", timeout: 1 } }, support: allEventSupport("supported"),
    getBinding: async () => ({ targetPath: target, hostFingerprint: "fixture-host", configFingerprint: "fixture-config", capabilityFingerprint: "fixture-capability", targetVersion: "codex-cli 0.154.0", appVersion: "0.8.1", busy: false, blockers: [] }),
    phase: stage => phase?.(stage, target) ?? Promise.resolve() })
  transactions.push(transaction)
  const latest = async () => { const { id } = JSON.parse(await readFile(join(storageRoot, `latest-${hashText(target)}.json`), "utf8")); return JSON.parse(await readFile(join(storageRoot, `${id}.receipt.json`), "utf8")) }
  return { transaction, target, foreign, latest, storageRoot }
}

it("commits and removes Hooks on the real host filesystem without a spurious post-commit conflict", async () => {
  const f = await fixture()
  const plan = await f.transaction.prepare("install", "settings")
  expect(plan.canApply).toBe(true)
  expect(await f.transaction.apply(plan.planId, "settings")).toMatchObject({ status: "applied", warning: null })
  expect((await f.latest()).phase).toBe("applied")
  expect(JSON.parse(await readFile(f.target, "utf8")).hooks.Stop[0].hooks[0]).toEqual(f.foreign.hooks.Stop[0].hooks[0])
  const remove = await f.transaction.prepare("uninstall", "settings")
  expect(await f.transaction.apply(remove.planId, "settings")).toMatchObject({ status: "applied", warning: null })
  expect(JSON.parse(await readFile(f.target, "utf8"))).toEqual(f.foreign)
  expect((await f.latest()).phase).toBe("applied")
})

it("retires a prepared receipt after a pre-commit abort on both Windows and POSIX", async () => {
  const f = await fixture(async stage => { if (stage === "before-final-check") throw Error("PLAN_STALE") })
  const plan = await f.transaction.prepare("install", "settings")
  await expect(f.transaction.apply(plan.planId, "settings")).rejects.toThrow("PLAN_STALE")
  expect((await f.latest()).phase).toBe("aborted-before-commit")
  expect(JSON.parse(await readFile(f.target, "utf8"))).toEqual(f.foreign)
})

it("still reports a real conflicting writer after rename without rolling its changes back", async () => {
  const changed = { hooks: {}, foreign: "changed" }
  const f = await fixture(async (stage, target) => { if (stage === "after-commit") await writeFile(target, JSON.stringify(changed)) })
  const plan = await f.transaction.prepare("install", "settings")
  expect(await f.transaction.apply(plan.planId, "settings")).toMatchObject({ status: "committed-conflict", warning: "POST_COMMIT_CONFLICT" })
  expect(JSON.parse(await readFile(f.target, "utf8"))).toEqual(changed)
})
