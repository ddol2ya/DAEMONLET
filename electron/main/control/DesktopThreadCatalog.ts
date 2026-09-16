import { lstat, open, readdir, realpath } from "node:fs/promises"
import { constants } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { belongsToLocalCodexHome, isThreadUuid } from "./CodexThreadLauncher"

export type DesktopThreadMetadata = { id: string; title: string; cwd: string; path: string; updatedAt: number }
const text = (v: unknown, max: number) => typeof v === "string" ? v.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, max) : ""
const sources = new Set(["vscode", "cli", "exec", "appServer", "app_server"])
// Windows reports synthetic uid/mode values; access is enforced by its ACLs.
// Keep file type, link and canonical-path checks on both platforms.
const privateToUser = (info: { uid: number; mode: number }, uid = process.getuid?.()) =>
  process.platform === "win32" || info.uid === uid && (info.mode & 0o022) === 0

/** The app's fallback title shows the request, not its attachment transport wrapper. */
function requestTitle(value: unknown): string {
  if (typeof value !== "string") return ""
  const marker = "\n## My request:\n", boundary = value.indexOf(marker)
  if (value.startsWith("# Files mentioned by the user:") && boundary >= 0) value = value.slice(boundary + marker.length)
  return text(value, 120).trim()
}

/** Codex's renamed session titles. Bounded metadata-only tail; never inspect rollout content. */
async function readSessionNames(root: string, uid: number): Promise<Map<string, string>> {
  const latest = new Map<string, { at: number; name: string }>()
  let file: Awaited<ReturnType<typeof open>> | null = null
  try {
    const path = join(root, "session_index.jsonl"), named = await lstat(path)
    if (!named.isFile() || named.isSymbolicLink()) return new Map()
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = await file.stat()
    if (!stat.isFile() || !privateToUser(stat, uid) || stat.nlink !== 1 || stat.dev !== named.dev || stat.ino !== named.ino) return new Map()
    const start = Math.max(0, stat.size - 256 * 1024), buffer = Buffer.alloc(Math.min(stat.size, 256 * 1024))
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start)
    let content = buffer.subarray(0, bytesRead).toString("utf8")
    if (start) content = content.slice(content.indexOf("\n") + 1)
    for (const line of content.split("\n")) {
      if (!line || line.length > 4096) continue
      try {
        const row = JSON.parse(line)
        if (!row || typeof row.id !== "string" || !isThreadUuid(row.id) || typeof row.thread_name !== "string" || typeof row.updated_at !== "string") continue
        const at = Date.parse(row.updated_at), name = text(row.thread_name, 120).trim()
        if (name && Number.isFinite(at) && at >= (latest.get(row.id)?.at ?? -Infinity)) latest.set(row.id, { at, name })
      } catch { /* An incomplete final record does not hide other session titles. */ }
    }
  } catch { /* Optional index: use the verified SQLite metadata when unavailable. */ }
  finally { await file?.close().catch(() => {}) }
  return new Map([...latest].map(([id, value]) => [id, value.name]))
}

/** Read only the local metadata index; neither resume saved threads nor query transcript columns. */
export async function readDesktopThreadCatalog(home: string, page?: { offset: number; query: string }, rawPage?: (hasMore: boolean) => void): Promise<DesktopThreadMetadata[]> {
  if (page && (!Number.isSafeInteger(page.offset) || page.offset < 0 || page.offset > 100000 || page.query.length > 120)) throw new Error("INVALID_REQUEST")
  const root = await realpath(home), info = await lstat(root)
  if (!info.isDirectory() || !privateToUser(info)) throw new Error("UNSAFE_SOCKET")
  const files = (await readdir(root)).filter(name => /^state_[1-9][0-9]?\.sqlite$/.test(name)).sort((a, b) => Number(b.slice(6, -7)) - Number(a.slice(6, -7)))
  if (!files.length) return []
  const path = join(root, files[0]), stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink() || !privateToUser(stat, info.uid) || stat.nlink !== 1) throw new Error("UNSAFE_SOCKET")
  const names = await readSessionNames(root, info.uid)
  const db = new DatabaseSync(path, { readOnly: true, enableDoubleQuotedStringLiterals: false })
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=100; PRAGMA cache_size=-512")
    const table = db.prepare("SELECT type FROM sqlite_schema WHERE name='threads'").get()
    if (table?.type !== "table") throw new Error("PROTOCOL_UNSUPPORTED")
    const columns = new Set(db.prepare("PRAGMA table_info(threads)").all().map(row => row.name))
    if (!["id", "rollout_path", "cwd", "title", "source", "updated_at", "archived"].every(name => columns.has(name))) throw new Error("PROTOCOL_UNSUPPORTED")
    const name = columns.has("name") ? "name" : "NULL"
    const query = page?.query.trim() ?? ""
    const pattern = `%${query.replace(/[\\%_]/g, value => "\\" + value)}%`
    const namedIds = query ? [...names].filter(([, title]) => title.toLocaleLowerCase().includes(query.toLocaleLowerCase())).slice(0, 128).map(([id]) => id) : []
    const where = query ? ` AND (title LIKE ? ESCAPE '\\' OR ${name} LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\'${namedIds.length ? ` OR id IN (${namedIds.map(() => "?").join(",")})` : ""})` : ""
    const rows = db.prepare(`SELECT id, rollout_path, cwd, title, ${name} AS name, source, updated_at FROM threads WHERE archived=0${where} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`).all(...(query ? [pattern, pattern, pattern, ...namedIds] : []), page ? 65 : 64, page?.offset ?? 0)
    rawPage?.(rows.length > 64)
    const result: DesktopThreadMetadata[] = []
    for (const row of rows.slice(0, 64)) {
      let source = row.source
      if (typeof source === "string" && source.startsWith('"')) { try { source = JSON.parse(source) } catch { continue } }
      if (typeof source !== "string" || !sources.has(source) || typeof row.id !== "string" || !isThreadUuid(row.id) || typeof row.rollout_path !== "string" || !belongsToLocalCodexHome(row.rollout_path, row.id, home)) continue
      const cwd = text(row.cwd, 2048), title = names.get(row.id) ?? (text(row.name, 120).trim() || requestTitle(row.title)), updatedAt = Number(row.updated_at)
      if (!cwd || !Number.isFinite(updatedAt)) continue
      result.push({ id: row.id, title: title || "연결된 대화", cwd, path: row.rollout_path, updatedAt })
    }
    return result
  } finally { db.close() }
}

export async function readDesktopThreadCatalogPage(home: string, page: { offset: number; query: string }) {
  let hasMore = false
  const items = await readDesktopThreadCatalog(home, page, more => { hasMore = more })
  // Pagination follows examined rows, including filtered metadata. An ineligible
  // page must not permanently hide eligible parents farther down the index.
  return { items, hasMore }
}
