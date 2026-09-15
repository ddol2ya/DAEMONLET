import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import { belongsToLocalCodexHome, isThreadUuid } from "../control/CodexThreadLauncher"
import type { ChatParent } from "./SideChatBackend"
export type ChatParentContext = { lastTurnId: string; contextAt: number; path: string }

/** Controlled metadata-only projection from an owned legacy rollout. No transcript
 * is returned or copied to the child home. Native fork reads the selected source. */
export async function readChatParentContext(home: string, parent: ChatParent): Promise<ChatParentContext> {
  if (!parent.path || !belongsToLocalCodexHome(parent.path, parent.threadId, home)) throw Error("PARENT_UNSUPPORTED")
  const [root, path, named] = await Promise.all([realpath(home), realpath(parent.path), lstat(parent.path)])
  if (!belongsToLocalCodexHome(path, parent.threadId, root) || named.isSymbolicLink() || !named.isFile() || named.nlink !== 1 || process.platform !== "win32" && (named.uid !== process.getuid?.() || (named.mode & 0o022) !== 0) || named.size > 128 * 1024 * 1024) throw Error("PARENT_UNSUPPORTED")
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  let buffer = "", first = true, last: ChatParentContext | null = null
  const line = (text: string) => {
    if (!text.trim()) return
    let item: any
    try { item = JSON.parse(text) } catch { throw Error("PARENT_UNSUPPORTED") }
    if (first) {
      first = false
      const meta = item.payload
      if (item.type !== "session_meta" || meta?.id !== parent.threadId || meta.history_mode && meta.history_mode !== "legacy") throw Error("PARENT_UNSUPPORTED")
      if (meta.dynamic_tools && (!Array.isArray(meta.dynamic_tools) || meta.dynamic_tools.length)) throw Error("PARENT_CAPABILITIES")
    } else if (item.type === "session_meta") throw Error("PARENT_UNSUPPORTED")
    const event = item.type === "event_msg" ? item.payload : null
    if (event && ["task_complete", "turn_complete", "turn_aborted"].includes(event.type) && isThreadUuid(event.turn_id)) {
      const at = Date.parse(item.timestamp)
      if (Number.isFinite(at)) last = { lastTurnId: event.turn_id, contextAt: at, path }
    }
  }
  try {
    const opened = await file.stat()
    if (opened.dev !== named.dev || opened.ino !== named.ino) throw Error("PARENT_UNSUPPORTED")
    // Bound the read to the observed size: a running parent may keep appending.
    const bytes = Buffer.alloc(64 * 1024)
    const decoder = new TextDecoder("utf-8", { fatal: true })
    for (let offset = 0; offset < opened.size;) {
      const count = Math.min(bytes.length, opened.size - offset), read = await file.read(bytes, 0, count, offset)
      if (!read.bytesRead) break
      offset += read.bytesRead; buffer += decoder.decode(bytes.subarray(0, read.bytesRead), { stream: true })
      for (let at; (at = buffer.indexOf("\n")) >= 0;) { if (at > 1024 * 1024) throw Error("PARENT_UNSUPPORTED"); line(buffer.slice(0, at)); buffer = buffer.slice(at + 1) }
      if (buffer.length > 1024 * 1024) throw Error("PARENT_UNSUPPORTED")
    }
    // Ignore an unfinished last record from the running parent, never guess its boundary.
    if (!last) throw Error("NO_PARENT")
    return last
  } finally { await file.close() }
}
