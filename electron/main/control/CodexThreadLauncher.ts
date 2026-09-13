import { realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join, relative, isAbsolute } from "node:path"
import { CodexAppLauncher } from "../activity/CodexAppLauncher"
import { rolloutSessionId } from "../../../adapter/codex/lifecycle/CodexRolloutPath"

export const isThreadUuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
export const normalizeLocalCodexPath = (path: string) => process.platform === "darwin" && (path.startsWith("/var/") || path.startsWith("/tmp/")) ? `/private${path}` : path
export function belongsToLocalCodexHome(path: string | null, threadId: string, home: string): boolean {
  if (!path || !isThreadUuid(threadId) || !isAbsolute(path) || path.includes("\0")) return false
  // The observer pins real paths; macOS's standard /var and /tmp aliases may occur in CODEX_HOME.
  const local = relative(normalizeLocalCodexPath(home), normalizeLocalCodexPath(path)).replace(/\\/g, "/")
  return !isAbsolute(local) && local.startsWith(`sessions/`) && rolloutSessionId(local) === threadId && !local.split(/[\\/]/).includes("..")
}

/** A verified conversation may move between rollout files without changing its title. */
export function sameLocalCodexConversationPath(a: string, b: string, threadId: string): boolean {
  a = normalizeLocalCodexPath(a).replace(/\\/g, "/"); b = normalizeLocalCodexPath(b).replace(/\\/g, "/")
  if (a === b) return true
  const boundary = a.lastIndexOf("/sessions/")
  return boundary > 0 && belongsToLocalCodexHome(a, threadId, a.slice(0, boundary)) && belongsToLocalCodexHome(b, threadId, a.slice(0, boundary))
}
/** Opens a verified shared-server thread in the user's ChatGPT desktop app. */
export class CodexThreadLauncher {
  private opening = false
  private lastOpen = -Infinity
  private readonly home: string
  constructor(private readonly options: { home?: string; app?: Pick<CodexAppLauncher, "openThread">; now?: () => number } = {}) {
    this.home = options.home ?? process.env.CODEX_HOME ?? join(homedir(), ".codex")
  }
  async open(target: { threadId: string; socketPath?: string; rolloutPath: string | null }): Promise<void> {
    if (!isThreadUuid(target.threadId)) throw new Error("INVALID_REQUEST")
    const now = (this.options.now ?? Date.now)()
    if (this.opening || now - this.lastOpen < 2000) throw new Error("REQUEST_LIMITED")
    this.opening = true; this.lastOpen = now
    try {
      if (!belongsToLocalCodexHome(target.rolloutPath, target.threadId, this.home)) throw new Error("UNAVAILABLE")
      const [home, path] = await Promise.all([realpath(this.home), realpath(target.rolloutPath!)])
      const info = await stat(path)
      if (!belongsToLocalCodexHome(path, target.threadId, home) || !info.isFile() || info.uid !== process.getuid?.()) throw new Error("UNAVAILABLE")
      const result = await (this.options.app ?? new CodexAppLauncher()).openThread(target.threadId)
      if (result !== "opened") throw new Error(result === "unavailable" ? "UNAVAILABLE" : "OPEN_FAILED")
    } finally { this.opening = false }
  }
  async dispose(): Promise<void> {}
}
