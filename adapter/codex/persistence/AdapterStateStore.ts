import { chmod, mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { PersistedRegistryState } from "../CodexRunRegistry.ts"

const SCHEMA_VERSION = 1

export type PersistedAdapterState = {
  schemaVersion: 1
  source: { name: "codex-adapter" }
  registry: PersistedRegistryState
  updatedAt: number
}

export type StateLoadResult = {
  state: PersistedAdapterState | null
  warning?: string
  corruptBackupPath?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

function validState(value: unknown): value is PersistedAdapterState {
  if (!isRecord(value) || value.schemaVersion !== SCHEMA_VERSION || !isRecord(value.source) || value.source.name !== "codex-adapter" || !isRecord(value.registry) || !Array.isArray(value.registry.runs)) return false
  return value.registry.runs.every((run) => {
    if (!isRecord(run) || typeof run.sessionId !== "string" || typeof run.turnId !== "string" || !["HOOK_OBSERVER", "APP_SERVER_OWNED", "APP_SERVER_ATTACH"].includes(String(run.backend)) || !Array.isArray(run.tasks)) return false
    if (run.waitingRequests !== undefined && (!Array.isArray(run.waitingRequests) || run.waitingRequests.length > 64 || !run.waitingRequests.every((request) => isRecord(request) && typeof request.requestId === "string" && request.requestId.length > 0 && request.requestId.length <= 512 && ["user-input", "approval"].includes(String(request.reason))))) return false
    return run.tasks.every((task) => isRecord(task) && typeof task.sourceTaskId === "string" && typeof task.category === "string" && typeof task.label === "string")
  })
}

export class AdapterStateStore {
  readonly dataDir: string
  readonly statePath: string
  lastPersistenceAt: number | null = null

  constructor(dataDir: string) {
    this.dataDir = dataDir
    this.statePath = join(dataDir, "adapter-state.json")
  }

  async ensureDirectory(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 })
    if (process.platform !== "win32") await chmod(this.dataDir, 0o700)
  }

  async load(): Promise<StateLoadResult> {
    try {
      const raw = await readFile(this.statePath, "utf8")
      const value = JSON.parse(raw) as unknown
      if (!validState(value)) throw new Error("state schema is invalid")
      return { state: value }
    } catch (error) {
      const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined
      if (code === "ENOENT") return { state: null }
      const backup = `${this.statePath}.corrupt-${Date.now()}`
      try {
        await rename(this.statePath, backup)
        return { state: null, warning: "corrupt adapter state was quarantined", corruptBackupPath: backup }
      } catch {
        return { state: null, warning: "adapter state could not be read or quarantined" }
      }
    }
  }

  async save(registry: PersistedRegistryState): Promise<void> {
    await this.ensureDirectory()
    const now = Date.now()
    const state: PersistedAdapterState = { schemaVersion: SCHEMA_VERSION, source: { name: "codex-adapter" }, registry, updatedAt: now }
    const temporary = join(dirname(this.statePath), `.adapter-state-${process.pid}-${now}.tmp`)
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
    if (process.platform !== "win32") await chmod(temporary, 0o600)
    // Windows FlushFileBuffers requires a handle opened for writing.
    const handle = await open(temporary, "r+")
    try { await handle.sync() } finally { await handle.close() }
    await rename(temporary, this.statePath)
    this.lastPersistenceAt = now
  }

  async getPermissionWarnings(): Promise<string[]> {
    if (process.platform === "win32") return ["Windows ACL ownership is not automatically broadened; verify the data directory is user-only"]
    const warnings: string[] = []
    try {
      const directoryMode = (await stat(this.dataDir)).mode & 0o777
      if (directoryMode !== 0o700) warnings.push(`data directory permissions are ${directoryMode.toString(8)}; expected 700`)
      const stateMode = (await stat(this.statePath)).mode & 0o777
      if (stateMode !== 0o600) warnings.push(`state file permissions are ${stateMode.toString(8)}; expected 600`)
    } catch {}
    return warnings
  }
}
