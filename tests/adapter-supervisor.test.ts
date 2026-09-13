import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"
import { createDesktopAdapterRuntimeConfig } from "../electron/main/DesktopAdapterConfig"
import { activityCorrelationKey, canonicalRunId } from "../adapter/codex/privacy/CanonicalId"

vi.mock("electron", () => ({ utilityProcess: { fork: vi.fn() } }))

class FakeUtility extends EventEmitter {
  readonly pid = 42_424
  readonly postMessage = vi.fn((message: { type: string }) => {
    if (message.type === "stop") queueMicrotask(() => { this.emit("message", { type: "stopped", reason: "requested" }); this.emit("exit", 0) })
  })
  readonly kill = vi.fn(() => this.emit("exit", 0))
}

const config = createDesktopAdapterRuntimeConfig({
  CODEX_PET_PROTOCOL_PORT: "43174",
  CODEX_PET_HOOK_PORT: "43175",
  CODEX_PET_DATA_DIR: "/tmp/daemonlet-supervisor-test",
})

function timers() {
  const pending = new Map<number, () => void>()
  let next = 1
  return {
    pending,
    setTimer: ((callback: () => void) => { const id = next++; pending.set(id, callback); return id }) as unknown as typeof setTimeout,
    clearTimer: ((id: number) => { pending.delete(id) }) as unknown as typeof clearTimeout,
    async runNext() {
      const entry = pending.entries().next().value as [number, () => void] | undefined
      if (!entry) throw new Error("no pending timer")
      pending.delete(entry[0])
      entry[1]()
      await vi.waitFor(() => undefined)
    },
  }
}

describe("AdapterSupervisor", () => {
  it("keeps validated owned-worker conversation mappings private and clears them on exit", async () => {
    const { AdapterSupervisor } = await import("../electron/main/AdapterSupervisor")
    const child = new FakeUtility(), home = "/private/tmp/conversation-home"
    const supervisor = new AdapterSupervisor({ workerPath: "/worker.cjs", config, codexHome: home, probe: async () => false, fork: vi.fn(() => child) as never })
    const listener = vi.fn(); supervisor.subscribeConversationKeys(listener)
    await supervisor.start()
    child.emit("message", { type: "ready", protocolEndpoint: config.protocolEndpoint, hookEndpoint: config.hookEndpoint })
    const sessionId = "01a08ffc-46d8-77f0-92c6-3b15412ed955", turnId = "01a090a0-0000-7000-8000-000000000001"
    const path = `${home}/sessions/2026/09/11/rollout-2026-09-11T00-00-00-${sessionId}.jsonl`
    const key = activityCorrelationKey(canonicalRunId(sessionId, turnId))
    child.emit("message", { type: "conversation-target", value: { sessionId, turnId, path: `/outside/${sessionId}.jsonl` } })
    expect(supervisor.conversationTarget(key)).toBeNull()
    child.emit("message", { type: "conversation-target", value: { sessionId, turnId, path } })
    expect(supervisor.conversationTarget(key)).toEqual({ threadId: sessionId, rolloutPath: path })
    expect([...listener.mock.calls.at(-1)![0]]).toEqual([key])
    expect(JSON.stringify(supervisor.getDiagnostics())).not.toMatch(/01a08ffc|rollout|conversation-home/)
    await supervisor.stop()
    expect(supervisor.conversationTarget(key)).toBeNull()
  })
  it("starts an owned worker with the shared config and stops gracefully", async () => {
    const { AdapterSupervisor } = await import("../electron/main/AdapterSupervisor")
    const child = new FakeUtility()
    const fork = vi.fn((..._args: unknown[]) => child)
    const supervisor = new AdapterSupervisor({ workerPath: "/worker.cjs", config, probe: async () => false, fork: fork as never })
    await supervisor.start()
    expect(child.postMessage).toHaveBeenCalledWith({ type: "start", mode: "HOOK_OBSERVER" })
    expect((fork.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv }).env).toMatchObject({
      CODEX_PET_DATA_DIR: config.dataDir,
      CODEX_PET_PROTOCOL_PORT: String(config.protocolPort),
      CODEX_PET_HOOK_PORT: String(config.hookPort),
    })
    child.emit("message", { type: "ready", protocolEndpoint: config.protocolEndpoint, hookEndpoint: config.hookEndpoint })
    expect(supervisor.getStatus().state).toBe("READY")
    expect(supervisor.getDiagnostics().adapterOwnership).toBe("OWNED_UTILITY")
    await supervisor.stop()
    expect(child.postMessage).toHaveBeenCalledWith({ type: "stop" })
    expect(supervisor.getStatus().state).toBe("STOPPED")
  })

  it("uses a verified external adapter without forking", async () => {
    const { AdapterSupervisor } = await import("../electron/main/AdapterSupervisor")
    const fork = vi.fn()
    const clock = timers()
    const supervisor = new AdapterSupervisor({ workerPath: "/worker.cjs", config, probe: async () => true, fork: fork as never, setTimer: clock.setTimer, clearTimer: clock.clearTimer })
    await supervisor.start()
    expect(supervisor.getStatus().state).toBe("EXTERNAL_RUNNING")
    expect(supervisor.getDiagnostics().adapterOwnership).toBe("EXTERNAL_PROCESS")
    expect(fork).not.toHaveBeenCalled()
    await supervisor.stop()
    expect(clock.pending.size).toBe(0)
  })

  it("forces owned mode without probing for an external adapter", async () => {
    const { AdapterSupervisor } = await import("../electron/main/AdapterSupervisor")
    const child = new FakeUtility()
    const probe = vi.fn(async () => true)
    const supervisor = new AdapterSupervisor({ workerPath: "/worker.cjs", config, allowExternalReuse: false, probe, fork: vi.fn(() => child) as never })
    await supervisor.start()
    expect(probe).not.toHaveBeenCalled()
    expect(child.postMessage).toHaveBeenCalledWith({ type: "start", mode: "HOOK_OBSERVER" })
    await supervisor.stop()
  })

  it("falls back to an owned worker after two external health failures", async () => {
    const { AdapterSupervisor } = await import("../electron/main/AdapterSupervisor")
    const clock = timers()
    const child = new FakeUtility()
    const probe = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
    const fork = vi.fn(() => child)
    const supervisor = new AdapterSupervisor({ workerPath: "/worker.cjs", config, probe, fork: fork as never, setTimer: clock.setTimer, clearTimer: clock.clearTimer })
    await supervisor.start()
    await clock.runNext()
    expect(supervisor.getStatus().state).toBe("EXTERNAL_RUNNING")
    expect(supervisor.getDiagnostics().externalProbeFailures).toBe(1)
    await clock.runNext()
    await vi.waitFor(() => expect(fork).toHaveBeenCalledOnce())
    expect(supervisor.getStatus().state).toBe("STARTING")
    expect(supervisor.getDiagnostics().adapterOwnership).toBe("NONE")
    await supervisor.stop()
  })

  it("does not fall back after one transient external probe failure", async () => {
    const { AdapterSupervisor } = await import("../electron/main/AdapterSupervisor")
    const clock = timers()
    const probe = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const fork = vi.fn()
    const supervisor = new AdapterSupervisor({ workerPath: "/worker.cjs", config, probe, fork: fork as never, setTimer: clock.setTimer, clearTimer: clock.clearTimer })
    await supervisor.start()
    await clock.runNext()
    await clock.runNext()
    expect(supervisor.getStatus().state).toBe("EXTERNAL_RUNNING")
    expect(supervisor.getDiagnostics().externalProbeFailures).toBe(0)
    expect(fork).not.toHaveBeenCalled()
    await supervisor.stop()
  })

  it("clears the external health timer before a manual restart", async () => {
    const { AdapterSupervisor } = await import("../electron/main/AdapterSupervisor")
    const clock = timers()
    const child = new FakeUtility()
    const probe = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const fork = vi.fn(() => child)
    const supervisor = new AdapterSupervisor({ workerPath: "/worker.cjs", config, probe, fork: fork as never, setTimer: clock.setTimer, clearTimer: clock.clearTimer })
    await supervisor.start()
    expect(clock.pending.size).toBe(1)
    await supervisor.restart()
    expect(clock.pending.size).toBe(0)
    expect(fork).toHaveBeenCalledOnce()
    await supervisor.stop()
  })

  it("reclassifies EADDRINUSE only when the port serves a valid adapter", async () => {
    const { AdapterSupervisor } = await import("../electron/main/AdapterSupervisor")
    const child = new FakeUtility()
    const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const supervisor = new AdapterSupervisor({ workerPath: "/worker.cjs", config, probe, fork: vi.fn(() => child) as never })
    await supervisor.start()
    child.emit("message", { type: "warning", code: "PORT_IN_USE", message: "listen EADDRINUSE" })
    await vi.waitFor(() => expect(supervisor.getStatus().state).toBe("EXTERNAL_RUNNING"))
    expect(supervisor.getDiagnostics().adapterOwnership).toBe("EXTERNAL_PROCESS")
    await supervisor.stop()
  })

  it("reports ERROR when EADDRINUSE belongs to an unverified process", async () => {
    const { AdapterSupervisor } = await import("../electron/main/AdapterSupervisor")
    const child = new FakeUtility()
    const probe = vi.fn().mockResolvedValue(false)
    const supervisor = new AdapterSupervisor({ workerPath: "/worker.cjs", config, probe, fork: vi.fn(() => child) as never })
    await supervisor.start()
    child.emit("message", { type: "warning", code: "PORT_IN_USE", message: "listen EADDRINUSE" })
    await vi.waitFor(() => expect(supervisor.getStatus()).toMatchObject({ state: "ERROR", message: "Adapter port is in use by an unverified process" }))
    expect(supervisor.getDiagnostics().adapterOwnership).toBe("NONE")
  })

  it("bounds crash restarts to three attempts in sixty seconds", async () => {
    const { AdapterSupervisor } = await import("../electron/main/AdapterSupervisor")
    const children: FakeUtility[] = []
    const supervisor = new AdapterSupervisor({
      workerPath: "/worker.cjs",
      config,
      probe: async () => false,
      now: () => 1_000,
      setTimer: ((callback: () => void) => { callback(); return 1 }) as unknown as typeof setTimeout,
      clearTimer: vi.fn() as unknown as typeof clearTimeout,
      fork: vi.fn(() => { const child = new FakeUtility(); children.push(child); return child }) as never,
    })
    await supervisor.start()
    for (let index = 0; index < 4; index++) children.at(-1)!.emit("exit", 1)
    expect(children).toHaveLength(4)
    expect(supervisor.getStatus()).toMatchObject({ state: "ERROR", restartCount: 3 })
  })

  it("SIGKILLs only its known owned utility during packaged smoke verification", async () => {
    const child = new FakeUtility()
    const killProcess = vi.fn()
    const supervisor = new (await import("../electron/main/AdapterSupervisor")).AdapterSupervisor({
      workerPath: "/worker.cjs",
      config,
      probe: async () => false,
      fork: vi.fn(() => child) as never,
      killProcess,
    })
    const previous = process.env.ELECTRON_SMOKE_TEST
    process.env.ELECTRON_SMOKE_TEST = "1"
    try {
      await supervisor.start()
      child.emit("message", { type: "ready", protocolEndpoint: config.protocolEndpoint, hookEndpoint: config.hookEndpoint })

      expect(supervisor.crashOwnedWorkerForSmokeTest()).toBe(true)
      expect(killProcess).toHaveBeenCalledOnce()
      expect(killProcess).toHaveBeenCalledWith(child.pid)
    } finally {
      if (previous === undefined) delete process.env.ELECTRON_SMOKE_TEST
      else process.env.ELECTRON_SMOKE_TEST = previous
      await supervisor.stop()
    }
  })
})
