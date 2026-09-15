import { access, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { CodexAdapterService } from "../adapter/codex/CodexAdapterService.ts"
import { createCodexAdapterConfig } from "../adapter/codex/CodexAdapterConfig.ts"

// CI Windows TEMP can use an 8.3 alias. Supply the canonical private root,
// matching the packaged app and preserving the endpoint publisher's path guard.
const dirs: string[] = []
const isolatedConfig = (dataDir: string, overrides: Parameters<typeof createCodexAdapterConfig>[0] = {}) => createCodexAdapterConfig({ ...overrides, dataDir, codexHome: join(dataDir, "codex-home"), protocolPort: 0, hookPort: 0 })
afterEach(async () => { await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

describe("CodexAdapterService", () => {
  it("excludes owned side chat hooks while retaining other clients' events", async () => {
    const dataDir = await realpath(await mkdtemp(join(tmpdir(), "codex-side-owned-"))); dirs.push(dataDir)
    const service = new CodexAdapterService(isolatedConfig(dataDir), { excludeSession: id => id === "owned-child" })
    await service.start()
    try {
      const token = (await readFile(join(dataDir, "adapter-token"), "utf8")).trim(), observed: unknown[] = []
      service.registry.subscribe(event => observed.push(event))
      for (const sessionId of ["owned-child", "other-client"]) for (const hookEventName of ["UserPromptSubmit", "Stop"]) expect((await fetch(service.getDiagnostics().hookIngress.endpoint, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ payloadVersion: 1, sessionId, turnId: "turn", model: "synthetic", permissionMode: "default", hookEventName, stopHookActive: false }) })).status).toBe(202)
      expect(observed).toHaveLength(2)
      expect(service.getDiagnostics().eventTrace).toHaveLength(2)
      expect(JSON.stringify(await readFile(join(dataDir, "adapter-state.json"), "utf8"))).not.toContain("owned-child")
    } finally { await service.stop() }
  })
  it("starts Hook Observer without executing a configured CLI candidate", async () => {
    const dataDir = await realpath(await mkdtemp(join(tmpdir(), "codex-no-cli-probe-")))
    dirs.push(dataDir)
    const codexPath = join(dataDir, "fake-codex")
    await writeFile(codexPath, '#!/bin/sh\nprintf executed > "${0}.executed"\n', { mode: 0o700 })
    const service = new CodexAdapterService(isolatedConfig(dataDir, { codexPath }))
    try {
      await service.start()
      await expect(access(`${codexPath}.executed`)).rejects.toThrow()
      expect(service.getDiagnostics()).toMatchObject({ status: "READY", codexVersion: null })
    } finally { await service.stop() }
  })
  it("keeps the production recovery TTL at two minutes and bounds the smoke override", () => {
    const previous = process.env.CODEX_PET_RECOVERY_TTL_MS
    try {
      delete process.env.CODEX_PET_RECOVERY_TTL_MS
      expect(createCodexAdapterConfig().recoveryTtlMs).toBe(120_000)
      process.env.CODEX_PET_RECOVERY_TTL_MS = "10000"
      expect(createCodexAdapterConfig().recoveryTtlMs).toBe(10_000)
      process.env.CODEX_PET_RECOVERY_TTL_MS = "999"
      expect(() => createCodexAdapterConfig()).toThrow("invalid recovery TTL")
    } finally {
      if (previous === undefined) delete process.env.CODEX_PET_RECOVERY_TTL_MS
      else process.env.CODEX_PET_RECOVERY_TTL_MS = previous
    }
  })

  it("connects authenticated hook ingress to registry, persistence, diagnostics, and protocol state", async () => {
    const dataDir = await realpath(await mkdtemp(join(tmpdir(), "codex-service-")))
    dirs.push(dataDir)
    const service = new CodexAdapterService(isolatedConfig(dataDir, { codexPath: process.execPath }))
    await service.start()
    try {
      const protocolEvents: unknown[] = []
      service.registry.subscribe((event) => protocolEvents.push(event))
      const token = (await readFile(join(dataDir, "adapter-token"), "utf8")).trim()
      const endpoint = service.getDiagnostics().hookIngress.endpoint
      const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }
      const stopCommon = { payloadVersion: 1, sessionId: "stop-session", model: "m", permissionMode: "default", turnId: "stop-turn" }
      expect((await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ ...stopCommon, hookEventName: "UserPromptSubmit" }) })).status).toBe(202)
      expect((await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ ...stopCommon, hookEventName: "Stop", stopHookActive: false }) })).status).toBe(202)

      const endCommon = { payloadVersion: 1, sessionId: "end-session", model: "m", turnId: "end-turn" }
      expect((await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ ...endCommon, hookEventName: "UserPromptSubmit" }) })).status).toBe(202)
      expect((await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ payloadVersion: 1, sessionId: "end-session", hookEventName: "SessionEnd", reason: "other" }),
      })).status).toBe(202)
      expect(service.registry.getSnapshot()).toEqual([])
      const diagnostics = service.getDiagnostics()
      expect(diagnostics).toMatchObject({ status: "READY", activeRunCount: 0, hookIngress: { accepted: 4 } })
      expect(diagnostics.eventTrace.map((entry) => entry.eventType)).toEqual(["run.started", "run.completed", "run.started", "session.ended"])
      expect(protocolEvents.map((event) => (event as { type: string }).type)).toEqual(["run.started", "run.completed", "run.started", "run.cancelled"])
      expect(JSON.stringify(diagnostics)).not.toContain("private prompt")
      expect(JSON.stringify(diagnostics)).not.toContain("/private/")
      expect(JSON.stringify(protocolEvents)).not.toMatch(/prompt|assistant|transcript|\/private\//)
      expect(await readFile(join(dataDir, "adapter-state.json"), "utf8")).not.toMatch(/private|assistant|transcript/)
    } finally {
      await service.stop()
    }
  })

  it("keeps the unverified attach backend disabled", () => {
    expect(() => new CodexAdapterService(createCodexAdapterConfig({ mode: "APP_SERVER_ATTACH", dataDir: "/tmp/codex-disabled" }))).toThrow("disabled")
  })

  it("persists an empty active state after an authenticated Interrupt", async () => {
    const dataDir = await realpath(await mkdtemp(join(tmpdir(), "codex-interrupt-")))
    dirs.push(dataDir)
    const service = new CodexAdapterService(isolatedConfig(dataDir, { codexPath: process.execPath }))
    await service.start()
    try {
      const protocolEvents: unknown[] = []
      service.registry.subscribe((event) => protocolEvents.push(event))
      const token = (await readFile(join(dataDir, "adapter-token"), "utf8")).trim()
      const endpoint = service.getDiagnostics().hookIngress.endpoint
      const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }
      const common = { payloadVersion: 1, sessionId: "interrupt-session", model: "m", permissionMode: "default", turnId: "interrupt-turn" }
      expect((await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ ...common, hookEventName: "UserPromptSubmit" }) })).status).toBe(202)
      expect((await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ ...common, hookEventName: "PreToolUse", toolName: "Bash", toolUseId: "tool" }) })).status).toBe(202)
      expect((await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ ...common, hookEventName: "Interrupt" }) })).status).toBe(202)

      expect(service.registry.getSnapshot()).toEqual([])
      expect(service.getDiagnostics()).toMatchObject({ activeRunCount: 0, activeTaskCount: 0, hookIngress: { accepted: 3 } })
      expect(service.getDiagnostics().eventTrace.map((entry) => entry.eventType)).toEqual(["run.started", "task.started", "run.cancelled"])
      expect(protocolEvents.map((event) => (event as { type: string }).type)).toEqual(["run.started", "task.started", "run.cancelled"])
      expect(JSON.parse(await readFile(join(dataDir, "adapter-state.json"), "utf8")).registry.runs).toEqual([])
    } finally {
      await service.stop()
    }
  })

  it("recovers an active run after adapter restart", async () => {
    const dataDir = await realpath(await mkdtemp(join(tmpdir(), "codex-restart-")))
    dirs.push(dataDir)
    const config = isolatedConfig(dataDir, { codexPath: process.execPath })
    const first = new CodexAdapterService(config)
    await first.start()
    const token = (await readFile(join(dataDir, "adapter-token"), "utf8")).trim()
    await fetch(first.getDiagnostics().hookIngress.endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ payloadVersion: 1, sessionId: "s", model: "m", turnId: "t", hookEventName: "UserPromptSubmit" }),
    })
    expect(first.registry.getSnapshot()).toHaveLength(1)
    await first.stop()

    const second = new CodexAdapterService(config)
    await second.start()
    try {
      expect(second.registry.getSnapshot()).toHaveLength(1)
      expect(second.getDiagnostics().recoveredRunCount).toBe(1)
    } finally { await second.stop() }
  })

  it("starts idle instead of restoring an old persisted run", async () => {
    const dataDir = await realpath(await mkdtemp(join(tmpdir(), "codex-stale-restart-")))
    dirs.push(dataDir)
    const service = new CodexAdapterService(isolatedConfig(dataDir, { codexPath: process.execPath }))
    await service.store.ensureDirectory()
    await service.store.save({
      runs: [{
        sessionId: "old-session",
        turnId: "old-turn",
        backend: "HOOK_OBSERVER",
        startedAt: 1,
        updatedAt: 1,
        tasks: [{ sourceTaskId: "old-task", category: "command", label: "Bash", startedAt: 1, updatedAt: 1 }],
      }],
    })

    await service.start()
    try {
      expect(service.registry.getSnapshot()).toEqual([])
      expect(service.getDiagnostics()).toMatchObject({ activeRunCount: 0, activeTaskCount: 0, recoveredRunCount: 0, staleRunCount: 1 })
      expect(JSON.parse(await readFile(join(dataDir, "adapter-state.json"), "utf8")).registry.runs).toEqual([])
    } finally { await service.stop() }
  })

  it("expires and persists an unconfirmed recovered run through service maintenance", async () => {
    const dataDir = await realpath(await mkdtemp(join(tmpdir(), "codex-recovery-deadline-")))
    dirs.push(dataDir)
    const recoveryTtlMs = 120_000
    let now = 1_000_000
    let runMaintenance: (() => Promise<void>) | null = null
    const clearMaintenanceTimer = vi.fn()
    const timer = { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>
    const service = new CodexAdapterService(
      isolatedConfig(dataDir, { codexPath: process.execPath, recoveryTtlMs }),
      {
        now: () => now,
        setMaintenanceTimer: (callback) => {
          runMaintenance = callback
          return timer
        },
        clearMaintenanceTimer,
      },
    )
    await service.store.ensureDirectory()
    await service.store.save({
      runs: [{
        sessionId: "recent-session",
        turnId: "recent-turn",
        backend: "HOOK_OBSERVER",
        startedAt: now - 61_000,
        updatedAt: now - 60_000,
        tasks: [],
      }],
    })
    const protocolEvents: unknown[] = []
    service.registry.subscribe((event) => protocolEvents.push(event))

    await service.start()
    try {
      expect(service.registry.getSnapshot()).toHaveLength(1)
      expect(service.getDiagnostics()).toMatchObject({
        activeRunCount: 1,
        provisionalRecoveredRunCount: 1,
      })

      now += recoveryTtlMs
      expect(runMaintenance).not.toBeNull()
      await (runMaintenance as unknown as () => Promise<void>)()

      expect(service.registry.getSnapshot()).toEqual([])
      expect(protocolEvents).toMatchObject([{ type: "run.cancelled", reason: "recovery-not-confirmed" }])
      expect(service.getDiagnostics()).toMatchObject({
        activeRunCount: 0,
        provisionalRecoveredRunCount: 0,
        staleRunCount: 1,
      })
      expect(JSON.parse(await readFile(join(dataDir, "adapter-state.json"), "utf8")).registry.runs).toEqual([])
    } finally {
      await service.stop()
    }
    expect(clearMaintenanceTimer).toHaveBeenCalledWith(timer)
  })
})
