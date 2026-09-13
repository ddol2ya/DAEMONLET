import { isThreadUuid } from "./CodexThreadLauncher"

const record = (v: unknown): v is Record<string, any> => Boolean(v && typeof v === "object" && !Array.isArray(v))
type Path = Array<string | number>
const leaves: Array<Array<string>> = [
  ["id"], ["title"], ["cwd"], ["threadRuntimeStatus", "type"], ["threadRuntimeStatus", "activeFlags", "#"], ["requests", "#", "method"],
  ["turnHistory", "kind"], ["turnHistory", "history", "islands", "#", "id"],
  ["turnHistory", "history", "islands", "#", "newerBoundary", "status"],
  ["turnHistory", "history", "islands", "#", "entries", "#", "value"],
  ...["turnId", "status", "turnStartedAtMs"].flatMap(key => [["turns", "#", key], ["turnHistory", "history", "entitiesByKey", "*", key]]),
]
const safeKey = (key: string | number) => typeof key === "number" ? Number.isInteger(key) && key >= 0 && key < 4096 : key.length <= 200 && !["__proto__", "constructor", "prototype"].includes(key)
const matches = (path: Path, leaf: string[]) => path.length <= leaf.length && path.every((key, i) => leaf[i] === "#" ? typeof key === "number" && safeKey(key) : leaf[i] === "*" ? typeof key === "string" && safeKey(key) : leaf[i] === key)
const relevant = (path: Path) => path.every(safeKey) && leaves.some(leaf => matches(path, leaf))
export const isDesktopStatePath = relevant

/** Drop message bodies, prompts, tool output, settings and attachments before retaining state. */
export function projectDesktopState(value: unknown, path: Path = []): any {
  if (!relevant(path)) return undefined
  const scalar = leaves.some(leaf => leaf.length === path.length && matches(path, leaf))
  if (scalar) return typeof value === "string" ? value.slice(0, 4096) : value === null || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value) ? value : undefined
  if (value === null) return null
  if (Array.isArray(value)) {
    if (value.length > 4096) throw new Error("PROTOCOL_UNSUPPORTED")
    return value.map((entry, i) => projectDesktopState(entry, [...path, i]))
  }
  if (!record(value)) return undefined
  const keys = Object.keys(value)
  if (keys.length > 4096) throw new Error("PROTOCOL_UNSUPPORTED")
  const result = Object.create(null)
  for (const key of keys) {
    const item = projectDesktopState(value[key], [...path, key])
    if (item !== undefined) result[key] = item
  }
  return result
}

export function applyDesktopPatches(state: Record<string, any>, patches: unknown): Record<string, any> {
  if (!Array.isArray(patches) || patches.length > 4096) throw new Error("PROTOCOL_UNSUPPORTED")
  for (const patch of patches) {
    if (!record(patch) || !["add", "replace", "remove"].includes(patch.op) || !Array.isArray(patch.path) || patch.path.length > 10 || !patch.path.every((key: unknown) => (typeof key === "string" || typeof key === "number") && safeKey(key))) throw new Error("PROTOCOL_UNSUPPORTED")
    const path = patch.path as Path
    if (!relevant(path)) continue
    if (!path.length) {
      const projected = projectDesktopState(patch.value)
      if (patch.op === "remove" || !record(projected)) throw new Error("PROTOCOL_UNSUPPORTED")
      state = projected; continue
    }
    let parent: any = state
    for (const key of path.slice(0, -1)) {
      if ((!record(parent) && !Array.isArray(parent)) || !Object.hasOwn(parent, key)) throw new Error("PROTOCOL_UNSUPPORTED")
      parent = (parent as Record<string, any>)[key]
    }
    const key = path.at(-1)!, projected = patch.op === "remove" ? undefined : projectDesktopState(patch.value, path)
    if (Array.isArray(parent)) {
      if (typeof key !== "number" || key > parent.length || patch.op !== "add" && key >= parent.length || parent.length >= 4096 && patch.op === "add") throw new Error("PROTOCOL_UNSUPPORTED")
      if (patch.op === "add") parent.splice(key, 0, projected)
      else if (patch.op === "remove") parent.splice(key, 1)
      else parent[key] = projected
    } else if (record(parent)) {
      if (patch.op === "remove") delete parent[key]
      else parent[key] = projected
    } else throw new Error("PROTOCOL_UNSUPPORTED")
  }
  return state
}

export type DesktopLiveState = { type: "active" | "idle" | "unknown"; turn: { id: string; status: "inProgress" | "completed" | "failed" | "interrupted" } | null; waiting: boolean }
export function desktopLiveState(state: unknown, threadId: string): DesktopLiveState {
  const unknown: DesktopLiveState = { type: "unknown", turn: null, waiting: false }
  if (!record(state) || state.id !== threadId) return unknown
  let turn: unknown = Array.isArray(state.turns) ? state.turns.at(-1) : null
  if (record(state.turnHistory) && state.turnHistory.kind === "canonical") {
    const history = state.turnHistory.history
    if (!record(history) || !Array.isArray(history.islands) || !record(history.entitiesByKey)) return unknown
    const island = history.islands.at(-1), key = island?.entries?.at(-1)?.value
    if (!record(island) || island.newerBoundary?.status !== "exhausted" || typeof key !== "string" || !Object.hasOwn(history.entitiesByKey, key)) return unknown
    turn = history.entitiesByKey[key]
  }
  const latest = record(turn) && isThreadUuid(turn.turnId) && ["inProgress", "completed", "failed", "interrupted"].includes(turn.status) ? { id: turn.turnId, status: turn.status as NonNullable<DesktopLiveState["turn"]>["status"] } : null
  const runtime = state.threadRuntimeStatus
  if (!record(runtime)) return unknown
  const waiting = Array.isArray(runtime.activeFlags) && runtime.activeFlags.some((flag: unknown) => flag === "waitingOnApproval" || flag === "waitingOnUserInput") || Array.isArray(state.requests) && state.requests.length > 0
  if (runtime.type === "active" && latest?.status === "inProgress") return { type: "active", turn: latest, waiting }
  if (runtime.type === "idle" && latest?.status !== "inProgress") return { type: "idle", turn: latest, waiting: false }
  return unknown
}
