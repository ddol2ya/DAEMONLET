import { it, expect, vi } from "vitest"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { UpdateService } from "../electron/main/updates/UpdateService"
import { BUNDLE_ID } from "../electron/shared/app-identity.mjs"
const info = { version: "0.7.3", tag: "v0.7.3", path: "Daemonlet-for-Codex-0.7.3-macOS-arm64.zip", sha512: Buffer.alloc(64, 1).toString("base64"), files: [{ url: "Daemonlet-for-Codex-0.7.3-macOS-arm64.zip", size: 1234567, sha512: Buffer.alloc(64, 1).toString("base64") }], minimumSystemVersion: "22.0.0", daemonlet: { appId: BUNDLE_ID, platform: "darwin", arch: "arm64", installType: "mac" } }
async function withService(test: (ctx: any) => Promise<void>) {
  const dataRoot = await mkdtemp(join(tmpdir(), "daemonlet-updates-"))
  const engine = { check: vi.fn(async () => info), download: vi.fn(async () => {}), verify: vi.fn(async () => {}), prepare: vi.fn(async () => {}), install: vi.fn(() => () => {}) }
  const options = { version: "0.7.2", platform: vi.fn(async () => ({ platform: "darwin", arch: "arm64", osVersion: "26.0.0", kind: "mac" as const, automatic: true })), engine: () => engine, dataRoot, autoCheck: vi.fn(() => false), confirmInstall: vi.fn(async () => true), prepareShutdown: vi.fn(async () => {}), handoff: vi.fn(), recoverFailure: vi.fn(), openExternal: vi.fn(async () => {}), now: () => 100000 }
  const service = new UpdateService(options)
  try { await test({ engine, options, service }) } finally { service.dispose(); await rm(dataRoot, { recursive: true, force: true }) }
}
it("does not make startup requests when automatic checks are OFF", () => withService(async ({ engine, service }) => { await service.start(); expect(engine.check).not.toHaveBeenCalled() }))
it("never downloads during a manual metadata check", () => withService(async ({ engine, service }) => { await service.act({ action: "check" }); expect(service.snapshot().phase).toBe("available"); expect(engine.download).not.toHaveBeenCalled(); expect(engine.prepare).not.toHaveBeenCalled() }))
it("ignores stale IDs and separates download from staging/restart", () => withService(async ({ engine, service }) => { await service.act({ action: "check" }); await service.act({ action: "download", candidateId: "stale" }); expect(engine.download).not.toHaveBeenCalled(); await service.act({ action: "download", candidateId: service.snapshot().candidateId }); expect(service.snapshot().phase).toBe("downloaded"); expect(engine.prepare).not.toHaveBeenCalled(); expect(engine.install).not.toHaveBeenCalled() }))
it("consent cancellation preserves child, draft and windows without preparation", () => withService(async ({ engine, options, service }) => { await service.act({ action: "check" }); const candidateId = service.snapshot().candidateId; await service.act({ action: "download", candidateId }); options.confirmInstall.mockResolvedValue(false); await service.act({ action: "installAndRestart", candidateId }); expect(service.snapshot().phase).toBe("downloaded"); expect(options.prepareShutdown).not.toHaveBeenCalled(); expect(engine.prepare).not.toHaveBeenCalled() }))
it("verifies and stages before owned cleanup, then hands off without app.exit", () => withService(async ({ engine, options, service }) => { const order: string[] = []; for (const key of ["verify", "prepare"]) engine[key].mockImplementation(async () => { order.push(key) }); engine.install.mockImplementation(() => { order.push("install"); return () => {} }); options.prepareShutdown.mockImplementation(async () => { service.stopBackgroundChecks(); order.push("cleanup") }); options.handoff.mockImplementation(() => { order.push("handoff") }); await service.act({ action: "check" }); const candidateId = service.snapshot().candidateId; await service.act({ action: "download", candidateId }); await service.act({ action: "installAndRestart", candidateId }); expect(order).toEqual(["verify", "prepare", "cleanup", "handoff", "install"]) }))
it("cleanup or signature failure cannot launch installer", () => withService(async ({ engine, options, service }) => { await service.act({ action: "check" }); const candidateId = service.snapshot().candidateId; await service.act({ action: "download", candidateId }); options.prepareShutdown.mockRejectedValue(Error("SAVE_FAILED")); await service.act({ action: "installAndRestart", candidateId }); expect(engine.install).not.toHaveBeenCalled(); expect(options.recoverFailure).toHaveBeenCalled(); expect(service.snapshot().reason).toBe("SAVE_FAILED") }))
it("cancels a slow download and rejects its late success", () => withService(async ({ engine, service }) => { let finish!: () => void; engine.download.mockImplementation(() => new Promise<void>(r => { finish = r })); await service.act({ action: "check" }); const pending = service.act({ action: "download", candidateId: service.snapshot().candidateId }); await Promise.resolve(); await service.act({ action: "cancelDownload" }); finish(); await pending; expect(service.snapshot().phase).toBe("available"); expect(engine.prepare).not.toHaveBeenCalled() }))
it("unsigned and portable installs never enter automatic download", () => withService(async ({ engine, options, service }) => { options.platform.mockResolvedValue({ platform: "darwin", arch: "arm64", osVersion: "26.0.0", kind: "mac", automatic: false, reason: "MAC_INSTALL_OR_TRUST" }); await service.act({ action: "check" }); expect(service.snapshot().phase).toBe("manualOnly"); await service.act({ action: "download", candidateId: service.snapshot().candidateId }); expect(engine.download).not.toHaveBeenCalled() }))
it("backs off background checks and rate limits repeated manual checks", () => withService(async ({ engine, options, service }) => { options.autoCheck.mockReturnValue(true); await service.check(true); await service.check(true); expect(engine.check).toHaveBeenCalledTimes(1); await service.check(false); await service.check(false); expect(engine.check).toHaveBeenCalledTimes(2) }))
it("does not install after OS shutdown while consent is pending", () => withService(async ({ engine, options, service }) => { let finish!: (yes: boolean) => void; options.confirmInstall.mockImplementation(() => new Promise(r => { finish = r })); await service.act({ action: "check" }); const candidateId = service.snapshot().candidateId; await service.act({ action: "download", candidateId }); const pending = service.act({ action: "installAndRestart", candidateId }); service.dispose(); finish(true); await pending; expect(engine.prepare).not.toHaveBeenCalled(); expect(engine.install).not.toHaveBeenCalled() }))

it("uses cached stable metadata without asking the engine for an older public version", () => withService(async ({ engine, options, service }) => { options.fetchLatest = vi.fn(async () => ({ status: 200, tag: "v0.7.1", etag: '"stable"' })); await service.act({ action: "check" }); expect(service.snapshot().phase).toBe("upToDate"); expect(engine.check).not.toHaveBeenCalled() }))
it("reports public metadata rate limits without downloading or requesting a token", () => withService(async ({ engine, options, service }) => { options.fetchLatest = vi.fn(async () => ({ status: 403 })); await service.act({ action: "check" }); expect(service.snapshot()).toMatchObject({ phase: "error", reason: "RATE_LIMITED" }); expect(engine.check).not.toHaveBeenCalled(); expect(engine.download).not.toHaveBeenCalled() }))

it("unsigned opt-in cancellation changes neither candidate nor download capability", () => withService(async ({ service, options }) => { options.setUnsignedWindowsPolicy = vi.fn(async () => false); await service.act({ action: "check" }); const before = service.snapshot(); await service.act({ action: "setUnsignedWindowsPolicy", enabled: true }); expect(service.snapshot()).toEqual(before) }))
it("changing unsigned policy invalidates the candidate and requires another check", () => withService(async ({ service, options, engine }) => { options.setUnsignedWindowsPolicy = vi.fn(async () => true); await service.act({ action: "check" }); const candidateId = service.snapshot().candidateId; await service.act({ action: "setUnsignedWindowsPolicy", enabled: true }); expect(service.snapshot()).toMatchObject({ phase: "idle", candidateId: undefined }); await service.act({ action: "download", candidateId }); expect(engine.download).not.toHaveBeenCalled() }))

it.each(["verify", "prepare"])("OS shutdown while %s is pending prevents further staging or cleanup", stage => withService(async ({ engine, options, service }) => { let finish!: () => void; engine[stage].mockImplementation(() => new Promise<void>(r => { finish = r })); await service.act({ action: "check" }); const candidateId = service.snapshot().candidateId; await service.act({ action: "download", candidateId }); const pending = service.act({ action: "installAndRestart", candidateId }); await vi.waitFor(() => expect(engine[stage]).toHaveBeenCalled()); service.dispose(); finish(); await pending; expect(options.prepareShutdown).not.toHaveBeenCalled(); expect(engine.install).not.toHaveBeenCalled(); if (stage === "verify") expect(engine.prepare).not.toHaveBeenCalled() }));
it("ignores late public metadata after shutdown", () => withService(async ({ options, service }) => { let finish!: (value: unknown) => void; options.fetchLatest = vi.fn(() => new Promise(r => { finish = r })); const pending = service.act({ action: "check" }); await vi.waitFor(() => expect(options.fetchLatest).toHaveBeenCalled()); service.dispose(); finish({ status: 200, tag: "v0.7.1" }); await pending; expect(service.snapshot().phase).toBe("checking") }));


it.each(["cleanup", "install"])("keeps error ownership after handoff cleanup when %s throws", stage => withService(async ({ engine, options, service }) => {
  options.prepareShutdown.mockImplementation(async () => { service.stopBackgroundChecks(); if (stage === "cleanup") throw Error("private cleanup detail") })
  if (stage === "install") engine.install.mockImplementation(() => { throw Error("private installer path") })
  await service.act({ action: "check" }); const candidateId = service.snapshot().candidateId
  await service.act({ action: "download", candidateId }); await service.act({ action: "installAndRestart", candidateId })
  expect(service.snapshot()).toMatchObject({ phase: "error", reason: "UPDATE_FAILED" })
  expect(options.recoverFailure).toHaveBeenCalledExactlyOnceWith("UPDATE_FAILED")
  const record = await readFile(join(options.dataRoot, "update-attempt.json"), "utf8")
  expect(JSON.parse(record)).toMatchObject({ fromVersion: "0.7.2", targetVersion: "0.7.3", failed: true })
  expect(record).not.toContain("private")
  if (stage === "cleanup") expect(engine.install).not.toHaveBeenCalled()
}))
it("captures event-only installer failures after return and ignores duplicate/old callbacks", () => withService(async ({ engine, options, service }) => {
  let notify!: (error: unknown) => void; const stop = vi.fn()
  engine.install.mockImplementation((onError: typeof notify) => { notify = onError; return stop })
  options.prepareShutdown.mockImplementation(async () => { service.stopBackgroundChecks() })
  await service.act({ action: "check" }); const candidateId = service.snapshot().candidateId
  await service.act({ action: "download", candidateId }); await service.act({ action: "installAndRestart", candidateId })
  expect(service.snapshot().phase).toBe("handoff")
  notify(Error("async failure")); await vi.waitFor(() => expect(options.recoverFailure).toHaveBeenCalledOnce())
  expect(service.snapshot().phase).toBe("error"); expect(stop).toHaveBeenCalledOnce()
  options.now = () => 200000
  await service.act({ action: "check" }); const next = service.snapshot()
  expect(next.phase).toBe("available"); expect(next.candidateId).not.toBe(candidateId)
  notify(Error("late former attempt"))
  expect(service.snapshot()).toEqual(next); expect(options.recoverFailure).toHaveBeenCalledOnce()
}))
it("does not recover or install after OS shutdown during cleanup", () => withService(async ({ engine, options, service }) => {
  options.prepareShutdown.mockImplementation(async () => { service.stopBackgroundChecks(); service.systemShutdown() })
  await service.act({ action: "check" }); const candidateId = service.snapshot().candidateId
  await service.act({ action: "download", candidateId }); await service.act({ action: "installAndRestart", candidateId })
  expect(engine.install).not.toHaveBeenCalled(); expect(options.recoverFailure).not.toHaveBeenCalled()
}))
it("final disposal detaches a handoff observer and ignores its late error", () => withService(async ({ engine, options, service }) => {
  let notify!: (error: unknown) => void; const stop = vi.fn()
  engine.install.mockImplementation((onError: typeof notify) => { notify = onError; return stop })
  await service.act({ action: "check" }); const candidateId = service.snapshot().candidateId
  await service.act({ action: "download", candidateId }); await service.act({ action: "installAndRestart", candidateId })
  service.dispose(); notify(Error("after process exit boundary"))
  expect(stop).toHaveBeenCalledOnce(); expect(options.recoverFailure).not.toHaveBeenCalled()
}))
it("reopening N after an incomplete handoff offers manual retry without automatic provider calls", () => withService(async ({ engine, options, service }) => {
  engine.install.mockImplementation(() => { throw Error("injected") })
  await service.act({ action: "check" }); const candidateId = service.snapshot().candidateId
  await service.act({ action: "download", candidateId }); await service.act({ action: "installAndRestart", candidateId }); service.dispose()
  engine.check.mockClear(); engine.install.mockReset().mockReturnValue(() => {}); options.autoCheck.mockReturnValue(true)
  const reopened = new UpdateService(options)
  try {
    expect(await reopened.start()).toBe(true)
    expect(reopened.snapshot()).toMatchObject({ phase: "error", reason: "PREVIOUS_UPDATE_INCOMPLETE", version: "0.7.3" })
    await reopened.check(true); expect(engine.check).not.toHaveBeenCalled()
    await reopened.act({ action: "check" }); expect(reopened.snapshot().phase).toBe("available")
    const retryId = reopened.snapshot().candidateId!
    await reopened.act({ action: "download", candidateId: retryId }); await reopened.act({ action: "installAndRestart", candidateId: retryId })
    expect(engine.install).toHaveBeenCalledOnce()
  } finally { reopened.dispose() }
}))
it("only an observed target-version boot resolves a pending successful handoff", () => withService(async ({ engine, options, service }) => {
  await service.act({ action: "check" }); const candidateId = service.snapshot().candidateId
  await service.act({ action: "download", candidateId }); await service.act({ action: "installAndRestart", candidateId }); service.dispose()
  expect(JSON.parse(await readFile(join(options.dataRoot, "update-attempt.json"), "utf8")).failed).toBe(false)
  const next = new UpdateService({ ...options, version: "0.7.3" })
  try { expect(await next.start()).toBe(false); expect(next.snapshot().phase).toBe("idle"); await expect(readFile(join(options.dataRoot, "update-attempt.json"))).rejects.toThrow() }
  finally { next.dispose() }
}))
