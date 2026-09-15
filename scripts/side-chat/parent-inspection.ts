import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import { belongsToLocalCodexHome } from "../../electron/main/control/CodexThreadLauncher"
import { inspectChatSource } from "../../electron/main/side-chat/SideChatSource"
import { safeSourceError } from "../../adapter/codex/app-server/SourceError"
import { readChatParentContext } from "../../electron/main/side-chat/SideChatParent"
import type { ChatParent } from "../../electron/main/side-chat/SideChatBackend"

/** Read-only suitability report. Never return paths, IDs, titles, tools or transcript text. */
export async function inspectParent(home: string, parent: ChatParent) {
  const result = { sourceHome: "UNKNOWN", access: "NOT_CHECKED", format: "UNKNOWN", dynamicTools: "UNKNOWN", terminalBoundary: "NOT_CHECKED", status: "BLOCKED_INPUT", reason: "PARENT_UNSUPPORTED" }
  let file: Awaited<ReturnType<typeof open>> | null = null
  try {
    if (!parent.path || !belongsToLocalCodexHome(parent.path, parent.threadId, home)) { result.sourceHome = "OUTSIDE"; return result }
    const root = await realpath(home), path = await realpath(parent.path), stat = await lstat(parent.path)
    result.sourceHome = belongsToLocalCodexHome(path, parent.threadId, root) ? "MATCH" : "OUTSIDE"
    if (result.sourceHome !== "MATCH") return result
    const fileIssue = stat.isSymbolicLink() ? "REDIRECTED_FILE" : !stat.isFile() ? "UNSUPPORTED_FILE_TYPE" : stat.nlink !== 1 ? "LINKED_FILE" : process.platform !== "win32" && (stat.uid !== process.getuid?.() || (stat.mode & 0o022)) ? "FILE_PERMISSIONS" : null
    if (fileIssue) { result.access = "UNSAFE"; result.reason = fileIssue; return result }
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const opened = await file.stat()
    if (stat.dev !== opened.dev || stat.ino !== opened.ino) { result.access = "CHANGED"; return result }
    result.access = "READABLE"
    let line = Buffer.alloc(0)
    const chunk = Buffer.alloc(4096)
    for (let offset = 0; offset < Math.min(opened.size, 1024 * 1024);) {
      const read = await file.read(chunk, 0, Math.min(chunk.length, opened.size - offset), offset)
      if (!read.bytesRead) break
      offset += read.bytesRead; line = Buffer.concat([line, chunk.subarray(0, read.bytesRead)])
      const end = line.indexOf(10)
      if (end >= 0) { line = line.subarray(0, end); break }
    }
    const header = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line))
    if (header.type !== "session_meta" || header.payload?.id !== parent.threadId) return result
    const meta = header.payload
    result.format = meta.history_mode === undefined || meta.history_mode === "legacy" ? "legacy" : meta.history_mode === "paginated" ? "paginated" : "UNKNOWN"
    result.dynamicTools = meta.dynamic_tools == null || Array.isArray(meta.dynamic_tools) && !meta.dynamic_tools.length ? "NONE" : Array.isArray(meta.dynamic_tools) ? "PRESENT" : "UNKNOWN"
    await file.close(); file = null
    const source = await inspectChatSource(home, parent)
    if (source.capabilities) { result.reason = "PARENT_CAPABILITIES"; result.terminalBoundary = "NOT_INSPECTED_BLOCKED_CAPABILITIES"; return result }
    if (result.format !== "legacy") { result.status = result.format === "paginated" ? "PATCH_REQUIRED" : "BLOCKED_INPUT"; result.reason = result.format === "paginated" ? "SOURCE_RUNTIME_UNSUPPORTED" : "PARENT_UNSUPPORTED"; result.terminalBoundary = "NOT_INSPECTED_NATIVE_PREPARATION_REQUIRED"; return result }
    if (result.dynamicTools !== "NONE") { result.reason = "PARENT_CAPABILITIES"; result.terminalBoundary = "NOT_INSPECTED_BLOCKED_CAPABILITIES"; return result }
    // Production validator remains the authority; inspection cannot admit a parent.
    await readChatParentContext(home, parent)
    result.terminalBoundary = "CONFIRMED"; result.status = "ELIGIBLE_PARENT_ONLY"; result.reason = "AUTH_AND_RUNTIME_NOT_CHECKED"
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    if (result.access === "NOT_CHECKED") result.access = code === "ENOENT" ? "MISSING" : "UNREADABLE"
    result.reason = error instanceof Error && error.message === "NO_PARENT" ? "NO_COMPLETED_BOUNDARY" : safeSourceError(error instanceof Error ? error.message : null) ?? "PARENT_UNSUPPORTED"
    if (result.reason === "NO_COMPLETED_BOUNDARY") result.terminalBoundary = "ABSENT"
  } finally { await file?.close() }
  return result
}
