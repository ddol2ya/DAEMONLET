import { execFile } from "node:child_process"
import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import { promisify } from "node:util"
import { join } from "node:path"
import { belongsToLocalCodexHome, isThreadUuid } from "../control/CodexThreadLauncher"
import type { LiveSession } from "../../../adapter/codex/lifecycle/LiveActivity"
import { rolloutSessionId } from "../../../adapter/codex/lifecycle/CodexRolloutPath"

const exec = promisify(execFile)
const MAX_LINE = 64 * 1024, MAX_TAIL = 2 * 1024 * 1024
const confirmed = new Map<string, { dev: number; ino: number; size: number; session: LiveSession }>()

/** Only writable rollout handles of the current user's real `codex` process
 * qualify. An old transcript or the observer's own read handle is insufficient.
 */
export function cliRolloutPaths(output: string): string[] {
  const paths = new Set<string>()
  let command = "", access = ""
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) { command = ""; access = "" }
    else if (line.startsWith("c")) command = line.slice(1)
    else if (line.startsWith("f")) access = ""
    else if (line.startsWith("a")) access = line.slice(1)
    else if (line.startsWith("n") && command === "codex" && ["w", "u"].includes(access) && line.endsWith(".jsonl")) paths.add(line.slice(1))
    if (paths.size >= 64) break
  }
  return [...paths]
}

export async function inspectOpenCodexRollout(home: string, path: string): Promise<LiveSession | null> {
  const readStartedAt = Date.now()
  const sessionId = rolloutSessionId(path)
  if (!sessionId || !belongsToLocalCodexHome(path, sessionId, home) || await realpath(path) !== path) return null
  let directory = await realpath(home)
  const parts = path.slice(directory.length + 1).split("/").slice(0, -1)
  for (const part of ["", ...parts]) {
    if (part) directory = join(directory, part)
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || info.mode & 0o022) return null
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.uid !== process.getuid?.() || info.mode & 0o022 || info.nlink !== 1) return null
    const first = Buffer.alloc(Math.min(MAX_LINE, info.size))
    const headerRead = await file.read(first, 0, first.length, 0)
    const end = first.subarray(0, headerRead.bytesRead).indexOf(10)
    if (end < 0) return null
    const header = JSON.parse(first.subarray(0, end).toString("utf8"))
    if (header.type !== "session_meta" || header.payload?.id !== sessionId || !["cli", "exec", "vscode", "appServer", "app_server"].includes(header.payload.source)) { confirmed.delete(path); return null }
    const source = ["cli", "exec"].includes(header.payload.source) ? "cli" : "desktop"
    const previous = confirmed.get(path)
    const sameFile = previous && previous.dev === info.dev && previous.ino === info.ino && info.size >= previous.size
    // Initial recovery can look past one large image/tool result. Later polls
    // use the small tail and the confirmed state of this same open file.
    for (const limit of sameFile ? [MAX_TAIL] : [MAX_TAIL, 8 * 1024 * 1024, 32 * 1024 * 1024, 64 * 1024 * 1024]) {
      const start = Math.max(end + 1, info.size - limit), buffer = Buffer.alloc(info.size - start)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, start)
      let content = buffer.subarray(0, bytesRead).toString("utf8")
      if (start !== end + 1) content = content.slice(content.indexOf("\n") + 1)
      let latest: LiveSession | null = null
      const ended = new Set<string>()
      if (previous && previous.dev === info.dev && previous.ino === info.ino && info.size >= previous.size && previous.session.status !== "running" && previous.session.turnId) ended.add(previous.session.turnId)
      // Inspect only lifecycle metadata; do not retain prompts or output bodies.
      for (const line of content.split("\n").slice(0, -1)) {
        // A terminal event may contain a long final message. Its complete line
        // is still bounded by MAX_TAIL; retain only its lifecycle fields.
        if (!line || line.length > MAX_TAIL || line.length > MAX_LINE && !line.slice(0, 256).includes('"type":"event_msg"')) continue
        try {
          const row = JSON.parse(line), p = row.payload
          if (!["event_msg", "turn_context", "token_usage_record"].includes(row.type) || !isThreadUuid(p?.turn_id) || !Number.isFinite(Date.parse(row.timestamp)) || Date.parse(row.timestamp) > Date.now() + 5000) continue
          const status = row.type === "turn_context" || row.type === "token_usage_record" || ["task_started", "item_started", "item_completed"].includes(p.type) ? "running" : p.type === "task_complete" ? "completed" : p.type === "turn_aborted" ? "interrupted" : null
          if (status === "running" && ended.has(p.turn_id)) continue
          if (status && status !== "running") ended.add(p.turn_id)
          if (status) latest = { sessionId, turnId: p.turn_id, source, path, status, waiting: false, waitingKnown: false, observedAt: Date.parse(row.timestamp), observation: { kind: "rollout", readStartedAt } }
        } catch { /* Ignore incomplete/non-lifecycle records. */ }
      }
      if (latest) {
        confirmed.set(path, { dev: info.dev, ino: info.ino, size: info.size, session: latest })
        while (confirmed.size > 64) confirmed.delete(confirmed.keys().next().value!)
        return latest
      }
      if (start === end + 1) break
    }
    // A long tool body may push the last lifecycle record out of the bounded
    // tail. Keep its last confirmation only while the same file is still open.
    return sameFile ? { ...previous.session, observation: { kind: "rollout", readStartedAt } } : null
  } finally { await file.close() }
}

export async function inspectOpenCliRollout(home: string, path: string): Promise<LiveSession | null> {
  const session = await inspectOpenCodexRollout(home, path)
  return session?.source === "cli" ? session : null
}

export async function readOpenCodexSessions(home: string): Promise<LiveSession[] | null> {
  if (process.platform !== "darwin" && process.platform !== "linux") return null
  let output: string
  try {
    output = (await exec(process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof", ["-nP", "-a", "-u", String(process.getuid?.()), "-c", "/^codex$/", "-Fpcfan"], { timeout: 2000, maxBuffer: 1024 * 1024 })).stdout
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string }
    if (failure.code === 1 && !failure.stderr?.trim()) output = failure.stdout ?? ""
    else return null
  }
  const sessions: LiveSession[] = []
  // Bound the open-handle inventory and inspect files sequentially.
  const paths = cliRolloutPaths(output)
  for (const path of confirmed.keys()) if (!paths.includes(path)) confirmed.delete(path)
  for (const path of paths) {
    const session = await inspectOpenCodexRollout(home, path).catch(() => null)
    if (session) sessions.push(session)
    if (sessions.length >= 16) break
  }
  return sessions
}
