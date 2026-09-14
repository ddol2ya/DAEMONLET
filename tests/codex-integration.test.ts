import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { createElement } from "react"
import { CodexIntegrationController } from "../electron/main/CodexIntegrationController"
import { CodexIntegrationStore } from "../electron/main/CodexIntegrationStore"
import { HookLiveObservation } from "../electron/main/HookLiveObservation"
import { createSetupDiagnostics } from "../electron/main/SetupDiagnostics"
import { emptyHookReceipts } from "../adapter/codex/hooks/HookEvents"
import { allEventSupport } from "../adapter/codex/hooks/HookInstallPlan"
import { notTestedHost } from "../adapter/codex/hooks/HookHostSelfTest"
import type { HookSetupDoctor, HookSetupDiscovery } from "../adapter/codex/doctor/HookSetupDoctor"
import type { SanitizedAdapterDiagnostics } from "../electron/shared/ipc-contract"
import type { SettingsDesktopApi } from "../electron/shared/codex-integration-contract"
import { ConnectionPage } from "../src/settings/ConnectionPage"

const roots: string[] = [], controllers: CodexIntegrationController[] = []
afterEach(async () => { await Promise.all(controllers.splice(0).map((controller) => controller.dispose())); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

async function fixture(temporaryLocation = false, platform: NodeJS.Platform = "darwin") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pet-integration-")))
  roots.push(root)
  const home = join(root, "codex"), userData = join(root, "userData")
  await mkdir(home, { mode: 0o700 }); await mkdir(userData, { mode: 0o700 })
  const original = JSON.stringify({ description: "PRIVATE_DESCRIPTION_CANARY", hooks: { Stop: [{ hooks: [{ type: "command", command: "PRIVATE_FOREIGN_COMMAND_CANARY" }] }] } })
  await writeFile(join(home, "hooks.json"), original, { mode: 0o600 })
  const discovery: HookSetupDiscovery = {
    checkedAt: Date.now(), home: { path: home, source: "selected" }, executable: { path: join(root, "codex-cli"), source: "selected", version: "codex-cli 9.0.0", probeStatus: "verified", fingerprint: "fixture-artifact" },
    capability: { contractId: "test-fixture", source: "test-fixture", surface: "synthetic", events: allEventSupport("supported") }, feature: "enabled", policy: "unknown", inlineOwnedConflict: false, configFingerprint: "config-1", warnings: [], manualFeatureInstruction: null, inspectedScope: ["selected-user-hooks.json"], uninspectedScope: ["hook-trust-store"],
  }
  const doctor = { inspect: vi.fn(async () => structuredClone(discovery)), invalidate: vi.fn(), dispose: vi.fn() }
  const adapter: SanitizedAdapterDiagnostics = { state: "READY", message: null, restartCount: 0, adapterOwnership: "OWNED_UTILITY", protocolEndpoint: "ws://127.0.0.1:4174/events", hookEndpoint: "http://127.0.0.1:4175/hook", activeRunCount: 0, activeTaskCount: 0, provisionalRecoveredRunCount: 0, protocolClientCount: 1, externalProbeFailures: 0, lastExternalProbeAt: null, warnings: ["PRIVATE_ADAPTER_STDERR_CANARY"], hookEvents: emptyHookReceipts() }
  const host = { available: true, reason: "ready" as const, fingerprint: "host-1", runAsNode: "enabled" as const, temporaryLocation }
  const make = () => {
    const controller = new CodexIntegrationController({
      userData, packaged: true, platform, appVersion: "0.2.0", doctor: doctor as unknown as HookSetupDoctor,
      launchSpec: { mode: "packaged-electron-node", executablePath: join(root, "Pet.app/Contents/MacOS/Pet"), forwarderPath: join(root, "Pet.app/Contents/Resources/codex/hook-forwarder.mjs"), dataDir: join(root, "data"), hookEndpoint: adapter.hookEndpoint },
      getAdapterDiagnostics: () => structuredClone(adapter), getFreshAdapterDiagnostics: async () => structuredClone(adapter),
      inspectHost: async () => ({ ...host }),
      selfTest: async () => ({ ...notTestedHost(), status: "passed", checkedAt: Date.now(), hostFingerprint: host.fingerprint, coldStartMs: 100, receiverVerified: true, sanitized: true }),
    })
    controllers.push(controller)
    return controller
  }
  const controller = make()
  const owner = "settings:main-frame"
  await controller.start()
  controller.windowOpened(owner)
  await controller.refresh(true)
  return { root, home, userData, original, discovery, doctor, adapter, host, controller, owner, make }
}

it("uses Windows Desktop connection without CLI probes, Hook installation or a false host PASS", async () => {
  const f = await fixture(false, "win32")
  const status = await f.controller.prepareConnection(f.owner)
  expect(status.app.platform).toBe("win32")
  expect(status.adapter).toMatchObject({ state: "READY", ownership: "OWNED_UTILITY" })
  expect(status.discovery).toBeNull()
  expect(status.host.available).toBe(false)
  expect(status.hostSelfTest.status).toBe("not-tested")
  expect(f.doctor.inspect).not.toHaveBeenCalled()
  await expect(f.controller.planHooks("install", f.owner)).rejects.toThrow("CONFIGURATION_UNAVAILABLE")
  expect(await readFile(join(f.home, "hooks.json"), "utf8")).toBe(f.original)
  await f.controller.dismissOnboarding("skipped", f.owner)
  const reopened = f.make()
  expect(await reopened.start()).toBe(false)
  expect(reopened.getStatus().onboarding).toBe("skipped")
})

describe.runIf(process.platform !== "win32")("[macOS Hook setup] connection state and first-run lifecycle", () => {
  it("persists a one-time skip independently of actual installation or observation", async () => {
    const f = await fixture()
    expect(f.controller.getStatus()).toMatchObject({ onboarding: "shown", configurationStatus: "not-installed", hookReviewStatus: "unknown", live: { status: "not-tested" } })
    await f.controller.dismissOnboarding("skipped", f.owner)
    const reopened = f.make()
    expect(await reopened.start()).toBe(false)
    expect(reopened.getStatus().onboarding).toBe("skipped")
    expect(await readFile(join(f.home, "hooks.json"), "utf8")).toBe(f.original)
  })
  it("requires the host test, separates synthetic success from live evidence, and installs only after preview approval", async () => {
    const f = await fixture()
    const blocked = await f.controller.planHooks("install", f.owner)
    expect(blocked.conflicts).toContain("HOST_SELF_TEST_REQUIRED")
    await f.controller.startLiveObservation("desktop", f.owner)
    await f.controller.runHostSelfTest(f.owner)
    expect(f.controller.getStatus()).toMatchObject({ hostSelfTest: { status: "passed" }, hookReviewStatus: "unknown", live: { status: "not-tested", desktopStopAttempt: "not-tested" } })
    const preview = await f.controller.planHooks("install", f.owner)
    expect(preview.canApply).toBe(true)
    expect(await readFile(join(f.home, "hooks.json"), "utf8")).toBe(f.original)
    await f.controller.applyHookPlan(preview.planId, f.owner)
    expect(f.controller.getStatus()).toMatchObject({ configurationStatus: "installed-current", hookReviewStatus: "review-required", live: { status: "not-tested", interrupt: "not-tested" } })
    await f.controller.reportHookReview(f.owner)
    expect(f.controller.getStatus().hookReviewStatus).toBe("user-reported-reviewed")
  })
  it("prepares discovery and the local host in one action while leaving Hooks and review untouched", async () => {
    const f = await fixture()
    const status = await f.controller.prepareConnection(f.owner)
    expect(status).toMatchObject({ hostSelfTest: { status: 'passed' }, configurationStatus: 'not-installed', hookReviewStatus: 'unknown', reception: { status: 'waiting', lastReceivedAt: null } })
    expect((await f.controller.planHooks('install', f.owner)).conflicts).not.toContain('HOST_SELF_TEST_REQUIRED')
    expect(await readFile(join(f.home, 'hooks.json'), 'utf8')).toBe(f.original)
    f.controller.windowClosed(f.owner)
    await expect(f.controller.prepareConnection(f.owner)).rejects.toThrow('PLAN_OWNER_MISMATCH')
  })
  it("receives automatically without a manual observation, a complete event checklist, or an asserted trust result", async () => {
    const f = await fixture()
    const receipt = f.adapter.hookEvents!.find(event => event.event === 'UserPromptSubmit')!
    receipt.count = 1; receipt.lastReceivedAt = Date.now()
    f.controller.notifyAdapterChanged()
    expect(f.controller.getStatus()).toMatchObject({ reception: { status: 'receiving', lastReceivedAt: receipt.lastReceivedAt }, live: { active: false, status: 'not-tested' }, hookReviewStatus: 'unknown' })
    f.controller.windowClosed(f.owner)
    expect(f.controller.getStatus().reception.status).toBe('receiving')
    f.adapter.adapterOwnership = 'EXTERNAL_PROCESS'
    expect(f.controller.getStatus().reception).toMatchObject({ status: 'unavailable', lastReceivedAt: null })
    f.adapter.adapterOwnership = 'OWNED_UTILITY'; f.adapter.state = 'ERROR'
    expect(f.controller.getStatus().reception.status).toBe('unavailable')
    f.adapter.state = 'READY'; f.adapter.hookEvents = emptyHookReceipts()
    expect(f.controller.getStatus().reception.status).toBe('waiting')
  })
  it("blocks transient app paths and inline duplication without TOML migration", async () => {
    const f = await fixture(true)
    await f.controller.runHostSelfTest(f.owner)
    expect((await f.controller.planHooks("install", f.owner)).conflicts).toContain("PERMANENT_APP_LOCATION_REQUIRED")
    f.host.temporaryLocation = false
    f.discovery.inlineOwnedConflict = true
    expect((await f.controller.planHooks("repair", f.owner)).conflicts).toContain("INLINE_OWNED_HOOK_CONFLICT")
    expect(await readFile(join(f.home, "hooks.json"), "utf8")).toBe(f.original)
  })
  it("holds install and repair when a matched CLI contract has no verified effective feature state", async () => {
    const f = await fixture()
    f.discovery.executable.probeStatus = "failed"
    f.discovery.feature = "unknown"
    f.discovery.warnings = ["CODEX_PROBE_FAILED"]
    await f.controller.runHostSelfTest(f.owner)
    for (const action of ["install", "repair"] as const) {
      const plan = await f.controller.planHooks(action, f.owner)
      expect(plan.canApply).toBe(false)
      expect(plan.conflicts).toContain("HOOK_FEATURE_UNKNOWN")
    }
    expect(await readFile(join(f.home, "hooks.json"), "utf8")).toBe(f.original)
  })
  it("invalidates host proof, review and observation after a host/config change", async () => {
    const f = await fixture()
    await f.controller.runHostSelfTest(f.owner)
    const plan = await f.controller.planHooks("install", f.owner)
    await f.controller.applyHookPlan(plan.planId, f.owner)
    await f.controller.reportHookReview(f.owner)
    await f.controller.startLiveObservation("desktop", f.owner)
    const observedAt = Date.now() + 1
    for (const item of f.adapter.hookEvents!) if (["UserPromptSubmit", "Stop", "Interrupt"].includes(item.event)) { item.count = 1; item.lastReceivedAt = observedAt }
    expect(f.controller.getStatus().live).toMatchObject({ status: "observed", interrupt: "observed", desktopStopAttempt: "not-tested" })
    f.host.fingerprint = "host-2"
    f.discovery.configFingerprint = "config-2"
    await f.controller.refresh(true)
    expect(f.controller.getStatus()).toMatchObject({ hostSelfTest: { status: "not-tested" }, hookReviewStatus: "review-required", live: { status: "not-tested", desktopStopAttempt: "not-tested" } })
  })
  it("revokes a closed frame's plan and preserves Pet/Adapter ownership", async () => {
    const f = await fixture()
    await f.controller.runHostSelfTest(f.owner)
    const plan = await f.controller.planHooks("install", f.owner)
    f.controller.windowClosed(f.owner)
    expect(() => f.controller.applyHookPlan(plan.planId, f.owner)).toThrow("PLAN_OWNER_MISMATCH")
    expect(f.adapter).toMatchObject({ state: "READY", adapterOwnership: "OWNED_UTILITY" })
    expect(f.doctor.invalidate).toHaveBeenCalled()
    expect(await readFile(join(f.home, "hooks.json"), "utf8")).toBe(f.original)
  })
  it("reports external ownership, refuses observation and does not assume the external process is idle", async () => {
    const f = await fixture()
    f.adapter.state = "EXTERNAL_RUNNING"
    f.adapter.adapterOwnership = "EXTERNAL_PROCESS"
    f.controller.notifyAdapterChanged()
    await expect(f.controller.startLiveObservation("desktop", f.owner)).rejects.toThrow("OWNED_ADAPTER_REQUIRED")
    expect(f.controller.getStatus().adapter).toMatchObject({ state: "EXTERNAL_RUNNING", ownership: "EXTERNAL_PROCESS" })
    expect((await f.controller.planHooks("install", f.owner)).conflicts).toContain("ADAPTER_STATE_UNCONFIRMED")
  })
  it("keeps foreign config, arbitrary diagnostics and raw identities out of DOM and export", async () => {
    const f = await fixture()
    await f.controller.runHostSelfTest(f.owner)
    const plan = await f.controller.planHooks("install", f.owner)
    const status = f.controller.getStatus()
    const rendered = renderToStaticMarkup(createElement(ConnectionPage, { status, api: {} as SettingsDesktopApi, busy: null, run: async () => undefined }))
    const exported = JSON.stringify(createSetupDiagnostics(status))
    for (const text of [JSON.stringify(status), JSON.stringify(plan), rendered, exported]) expect(text).not.toContain("PRIVATE_")
    expect(exported).not.toContain(f.root)
    expect(exported).not.toMatch(/sessionId|turnId|runId|taskId|beforeOwned|afterOwned|generatedCommand/)
    expect(rendered).not.toContain("연동 완료")
    expect(rendered).not.toContain("<canvas")
  })
  it("preserves an unreadable/newer app store without overwriting it", async () => {
    const f = await fixture()
    const path = join(f.userData, "codex-integration.json")
    const original = '{"version":99,"selection":"preserve"}'
    await writeFile(path, original)
    const store = new CodexIntegrationStore(f.userData)
    expect((await store.load()).issue).toBe("INTEGRATION_STORE_UNREADABLE")
    await expect(store.save(store.get())).rejects.toThrow("INTEGRATION_STORE_UNREADABLE")
    expect(await readFile(path, "utf8")).toBe(original)
  })
})

describe("event observation semantics", () => {
  it("excludes prior receipts, records a user-declared surface, and keeps Desktop stop separate", () => {
    const state = new HookLiveObservation(), counters = emptyHookReceipts()
    for (const item of counters) { item.count = 10; item.lastReceivedAt = 90 }
    state.start("desktop", counters, 100)
    state.update(counters, allEventSupport("supported"), true)
    expect(state.get().status).toBe("not-tested")
    for (const item of counters) if (["UserPromptSubmit", "Stop", "Interrupt"].includes(item.event)) { item.count++; item.lastReceivedAt = 110 }
    state.update(counters, allEventSupport("supported"), true)
    expect(state.get()).toMatchObject({ surface: "desktop", status: "observed", interrupt: "observed", desktopStopAttempt: "not-tested" })
    state.reportDesktopStopAttempt()
    expect(state.get().desktopStopAttempt).toBe("user-reported")
    state.update(emptyHookReceipts(), allEventSupport("supported"), true)
    expect(state.get()).toMatchObject({ status: "not-tested", active: false, desktopStopAttempt: "not-tested" })
  })
})
