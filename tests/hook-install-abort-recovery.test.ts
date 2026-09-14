/**
 * PR #11 regression fixture.
 * Copy to tests/hook-install-abort-recovery.test.ts in ddol2ya/daemonlet.
 * Run: npx vitest run tests/hook-install-abort-recovery.test.ts
 * These acceptance tests are expected to FAIL on reviewed HEAD 7f2d6cd.
 * They operate only on freshly created temporary files, never real Codex Home.
 */
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, it } from "vitest"
import { allEventSupport, hookHandler } from "../adapter/codex/hooks/HookInstallPlan"
import {
  HookInstallTransaction,
  type HookTransactionOptions,
  type InstallationBinding,
} from "../adapter/codex/hooks/HookInstallTransaction"

const roots: string[] = []
const transactions: HookInstallTransaction[] = []
const oldHandler = hookHandler({
  mode: "development-node",
  executablePath: "/fixture/node",
  forwarderPath: "/fixture/hook-forwarder.mjs",
  dataDir: "/fixture/data-v1",
  hookEndpoint: "http://127.0.0.1:4175/hook",
})
const newHandler = hookHandler({
  mode: "development-node",
  executablePath: "/fixture/node",
  forwarderPath: "/fixture/hook-forwarder.mjs",
  dataDir: "/fixture/data-v2",
  hookEndpoint: "http://127.0.0.1:4175/hook",
})
const foreign = { type: "command", command: "echo synthetic-foreign-handler" }
const original = JSON.stringify({ hooks: { Stop: [{ hooks: [foreign] }] } })
const externalEdit = JSON.stringify({
  note: "keep this independent edit",
  hooks: { Stop: [{ hooks: [foreign, { type: "command", command: "echo later-foreign" }] }] },
})

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pr11-abort-regression-")))
  roots.push(root)
  const codexHome = join(root, "codex")
  const storageRoot = join(root, "private-receipts")
  const target = join(codexHome, "hooks.json")
  await mkdir(codexHome, { mode: 0o700 })
  await writeFile(target, original, { mode: 0o600 })
  const binding: InstallationBinding = {
    targetPath: target, hostFingerprint: "synthetic-host", configFingerprint: "synthetic-config",
    capabilityFingerprint: "synthetic-capability", targetVersion: "synthetic",
    appVersion: "synthetic", busy: false, blockers: [],
  }
  const make = (phase?: HookTransactionOptions["phase"], handler = oldHandler) => {
    const tx = new HookInstallTransaction({
      codexHome, storageRoot, context: { desiredHandler: handler },
      support: allEventSupport("supported"), getBinding: async () => structuredClone(binding),
      ...(phase ? { phase } : {}),
    })
    transactions.push(tx)
    return tx
  }
  return { target, binding, make }
}

afterEach(async () => {
  await Promise.allSettled(transactions.splice(0).map((tx) => tx.dispose()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe.runIf(process.platform !== "win32")("[POSIX filesystem] known pre-commit abort does not poison future installation plans", () => {
  it("preserves a late external edit and allows a fresh approved plan after recreating the transaction", async () => {
    const f = await fixture()
    const tx = f.make(async (phase) => {
      if (phase === "before-rename") await writeFile(f.target, externalEdit, { mode: 0o600 })
    })
    const first = await tx.prepare("install", "old-window")
    await assert.rejects(tx.apply(first.planId, "old-window"), /PLAN_STALE/)
    assert.equal(await readFile(f.target, "utf8"), externalEdit)
    await tx.dispose()

    const retry = f.make()
    const preview = await retry.prepare("install", "new-window")
    assert.equal(preview.canApply, true, `Known abort must not require crash recovery: ${preview.conflicts.join(",")}`)
    assert.equal(await readFile(f.target, "utf8"), externalEdit, "A new preview must not modify the file")
    const result = await retry.apply(preview.planId, "new-window")
    assert.equal(result.status, "applied")
    const after = JSON.parse(await readFile(f.target, "utf8"))
    assert.equal(after.note, "keep this independent edit")
    assert.deepEqual(after.hooks.Stop[0].hooks, JSON.parse(externalEdit).hooks.Stop[0].hooks)
  })

  it("does not reinterpret a known disk-error abort as an ambiguous commit after a later foreign edit", async () => {
    const f = await fixture()
    const tx = f.make(async (phase) => {
      if (phase === "before-temporary-write") throw new Error("ENOSPC")
    })
    const first = await tx.prepare("install", "window")
    await assert.rejects(tx.apply(first.planId, "window"), /ENOSPC/)
    assert.equal(await readFile(f.target, "utf8"), original)
    await writeFile(f.target, externalEdit, { mode: 0o600 })
    await tx.dispose()

    const retry = f.make()
    const preview = await retry.prepare("install", "new-window")
    assert.equal(preview.canApply, true, `Previously handled abort must remain retryable: ${preview.conflicts.join(",")}`)
    assert.equal(await readFile(f.target, "utf8"), externalEdit)
  })

  it("retains the prior successful receipt and permits uninstall after an aborted repair", async () => {
    const f = await fixture()
    const firstTx = f.make()
    const installed = await firstTx.prepare("install", "window")
    await firstTx.apply(installed.planId, "window")
    f.binding.hostFingerprint = "synthetic-host-v2"
    let changed = ""
    const repairTx = f.make(async (phase) => {
      if (phase !== "before-rename") return
      const file = JSON.parse(await readFile(f.target, "utf8"))
      file.hooks.Stop[0].hooks.push({ type: "command", command: "echo added-during-repair" })
      changed = JSON.stringify(file)
      await writeFile(f.target, changed, { mode: 0o600 })
    }, newHandler)
    const repair = await repairTx.prepare("repair", "window")
    await assert.rejects(repairTx.apply(repair.planId, "window"), /PLAN_STALE/)
    assert.equal(await readFile(f.target, "utf8"), changed)
    await repairTx.dispose()

    const next = f.make(undefined, newHandler)
    assert.equal((await next.receipts()).last?.id, installed.planId, "Aborted attempt must not hide the last successful app change")
    const uninstall = await next.prepare("uninstall", "new-window")
    assert.equal(uninstall.canApply, true, `Confirmed old handlers must remain removable: ${uninstall.conflicts.join(",")}`)
    await next.apply(uninstall.planId, "new-window")
    const after = JSON.parse(await readFile(f.target, "utf8"))
    assert.equal(after.hooks.UserPromptSubmit, undefined)
    assert.deepEqual(after.hooks.Stop[0].hooks, [foreign, { type: "command", command: "echo added-during-repair" }])
  })
})
