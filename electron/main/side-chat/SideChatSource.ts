import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import { belongsToLocalCodexHome, isThreadUuid } from "../control/CodexThreadLauncher"
import type { ChatParent } from "./SideChatBackend"
import { readChatParentContext, type ChatParentContext } from "./SideChatParent"

export type PaginatedChatSource = { format: "paginated"; path: string; readOnlySource: { sourceHome: string; sourceIdentity: string } }
export type ChatParentSource = ChatParentContext | PaginatedChatSource
export const PAGINATED_SOURCE_LIMITS = { scanBytes: 64 * 1024 * 1024, contextBytes: 16 * 1024 * 1024, recordBytes: 2 * 1024 * 1024, sourceFiles: 8, records: 100000, timeoutMs: 15000 } as const

/** Main-owned metadata inspection. Reads only the first bounded record, never a
 * database, credentials or a transcript body. This does not establish a boundary. */
export async function inspectChatSource(home: string, parent: ChatParent) {
  if (!parent.path || !belongsToLocalCodexHome(parent.path, parent.threadId, home)) throw Error("SOURCE_SCOPE")
  const [root, path, named, owner] = await Promise.all([realpath(home), realpath(parent.path), lstat(parent.path, { bigint: true }), lstat(home, { bigint: true })]).catch(() => { throw Error("SOURCE_ACCESS") })
  if (!belongsToLocalCodexHome(path, parent.threadId, root) || named.isSymbolicLink() || !named.isFile() || named.nlink !== 1n || !owner.isDirectory()) throw Error("SOURCE_SCOPE")
  if (process.platform !== "win32" && (named.uid !== BigInt(process.getuid!()) || owner.uid !== named.uid || (named.mode & 0o022n) !== 0n || (owner.mode & 0o022n) !== 0n)) throw Error("SOURCE_PERMISSIONS")
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await file.stat({ bigint: true })
    if (opened.dev !== named.dev || opened.ino !== named.ino) throw Error("SOURCE_CHANGED")
    const bytes = Buffer.alloc(PAGINATED_SOURCE_LIMITS.recordBytes)
    let length = 0, end = -1
    while (length < bytes.length && end < 0) {
      const read = await file.read(bytes, length, Math.min(4096, bytes.length - length), length)
      if (!read.bytesRead) break
      end = bytes.indexOf(10, length); length += read.bytesRead
    }
    if (end < 0 || end >= length) throw Error("SOURCE_RECORD_LIMIT")
    let header: any
    try { header = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end))) } catch { throw Error("SOURCE_SCHEMA") }
    const meta = header.payload
    if (header.type !== "session_meta" || meta?.id !== parent.threadId) throw Error("SOURCE_IDENTITY")
    const format = meta.history_mode ?? "legacy"
    if (!["legacy", "paginated"].includes(format)) throw Error("SOURCE_SCHEMA")
    const capabilities = (meta.dynamic_tools != null && (!Array.isArray(meta.dynamic_tools) || meta.dynamic_tools.length > 0)) || (meta.selected_capability_roots != null && (!Array.isArray(meta.selected_capability_roots) || meta.selected_capability_roots.length > 0))
    return { format: format as "legacy" | "paginated", capabilities: Boolean(capabilities), path, readOnlySource: { sourceHome: root, sourceIdentity: `${opened.dev}:${opened.ino}` } }
  } catch (error) { throw error instanceof Error && /^SOURCE_/.test(error.message) ? error : Error("SOURCE_ACCESS") }
  finally { await file.close() }
}

/** Only the pinned read-only-source runtime contract may consume paginated input.
 * Diagnostic probes call this same resolver; no renderer or environment bypass. */
export async function resolveChatParentSource(home: string, parent: ChatParent, contract: "legacy" | "read-only-source-v1"): Promise<ChatParentSource> {
  const source = await inspectChatSource(home, parent)
  if (source.capabilities) throw Error("PARENT_CAPABILITIES")
  if (source.format === "legacy") return readChatParentContext(home, parent)
  if (contract !== "read-only-source-v1") throw Error("SOURCE_RUNTIME_UNSUPPORTED")
  if (process.platform !== "darwin" || process.arch !== "arm64") throw Error("SOURCE_PLATFORM_UNSUPPORTED")
  return { format: "paginated", path: source.path, readOnlySource: source.readOnlySource }
}

export function validateSourceSnapshot(value: any, source: PaginatedChatSource): ChatParentContext {
  const positive = (n: unknown, max: number) => typeof n === "number" && Number.isSafeInteger(n) && n > 0 && n <= max
  if (!value || !isThreadUuid(value.terminalTurnId) || value.sourceIdentity !== source.readOnlySource.sourceIdentity || !/^[a-f0-9]{64}$/.test(value.snapshotSha256) || !positive(value.contextAt, Math.floor(Date.now() / 1000) + 60) || !positive(value.endOrdinalExclusive, Number.MAX_SAFE_INTEGER) || !positive(value.endByteOffset, Number.MAX_SAFE_INTEGER) || !positive(value.sourceFiles, PAGINATED_SOURCE_LIMITS.sourceFiles) || !positive(value.scannedBytes, PAGINATED_SOURCE_LIMITS.scanBytes) || !positive(value.contextBytes, PAGINATED_SOURCE_LIMITS.contextBytes)) throw Error("SOURCE_BOUNDARY")
  return { path: source.path, lastTurnId: value.terminalTurnId, contextAt: value.contextAt * 1000 }
}
