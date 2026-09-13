import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { CodexRunRegistry } from "../adapter/codex/CodexRunRegistry.ts"
import { AdapterStateStore } from "../adapter/codex/persistence/AdapterStateStore.ts"
import { loadOrCreateAdapterToken } from "../adapter/codex/persistence/AdapterToken.ts"

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

describe("adapter state persistence", () => {
  it("atomically stores only bounded lifecycle state and restores canonical IDs", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "codex-state-"))
    dirs.push(dataDir)
    const store = new AdapterStateStore(dataDir)
    const registry = new CodexRunRegistry({ now: () => 2 })
    registry.apply({ type: "run.started", sessionId: "session", turnId: "turn", backend: "HOOK_OBSERVER", observedAt: 1 })
    registry.apply({ type: "task.started", sessionId: "session", turnId: "turn", taskId: "tool", category: "command", label: "Bash", observedAt: 2 })
    await store.save(registry.exportState())
    const raw = await readFile(store.statePath, "utf8")
    expect(raw).not.toMatch(/prompt|tool_input|tool_response|assistant response/i)
    const restored = new CodexRunRegistry({ now: () => 2 })
    const loaded = await store.load()
    if (loaded.state) restored.restore(loaded.state.registry)
    expect(restored.getSnapshot()).toEqual(registry.getSnapshot())
    if (process.platform !== "win32") {
      expect((await stat(dataDir)).mode & 0o777).toBe(0o700)
      expect((await stat(store.statePath)).mode & 0o777).toBe(0o600)
    }
  })

  it("does not revive runs outside the short crash-recovery window", async () => {
    const registry = new CodexRunRegistry({ now: () => 120_001, recoveryTtlMs: 120_000 })
    registry.restore({
      runs: [{
        sessionId: "stale-session",
        turnId: "stale-turn",
        backend: "HOOK_OBSERVER",
        startedAt: 1,
        updatedAt: 1,
        tasks: [{ sourceTaskId: "stale-task", category: "command", label: "Bash", startedAt: 1, updatedAt: 1 }],
      }],
    })

    expect(registry.getSnapshot()).toEqual([])
    expect(registry.recoveredRunCount).toBe(0)
    expect(registry.staleRunCount).toBe(1)
  })

  it("quarantines corrupt state and creates a private random token", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "codex-corrupt-"))
    dirs.push(dataDir)
    const store = new AdapterStateStore(dataDir)
    await writeFile(store.statePath, "not json")
    const loaded = await store.load()
    expect(loaded.state).toBeNull()
    expect(loaded.warning).toContain("quarantined")
    expect((await readdir(dataDir)).some((name) => name.includes("corrupt"))).toBe(true)
    const first = await loadOrCreateAdapterToken(dataDir)
    const second = await loadOrCreateAdapterToken(dataDir)
    expect(first.token).toBe(second.token)
    expect(Buffer.from(first.token, "base64url").byteLength).toBeGreaterThanOrEqual(32)
    if (process.platform !== "win32") expect((await stat(first.path)).mode & 0o777).toBe(0o600)
  })
})
