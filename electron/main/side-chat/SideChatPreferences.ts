import { constants } from "node:fs"
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises"
import { join, isAbsolute } from "node:path"
import { randomUUID } from "node:crypto"

export const SIDE_CHAT_CONSENT_VERSION = 1
export type ChatPreferences = { version: 1; consentVersion: number; executable: string | null; offNoticeSeen: boolean }
const defaults = (): ChatPreferences => ({ version: 1, consentVersion: 0, executable: null, offNoticeSeen: false })
export function normalizeChatPreferences(value: unknown): ChatPreferences {
  const v = value && typeof value === "object" ? value as Record<string, unknown> : {}
  return { version: 1, consentVersion: Number.isSafeInteger(v.consentVersion) && (v.consentVersion as number) >= 0 ? v.consentVersion as number : 0,
    executable: typeof v.executable === "string" && v.executable.length <= 4096 && isAbsolute(v.executable) && !/[\0\r\n]/.test(v.executable) ? v.executable : null,
    offNoticeSeen: v.offNoticeSeen === true }
}
/** Own app preferences only. Never writes Codex settings or shared task-control
 * selection. Consent records a policy version, not authorization for a send. */
export class SideChatPreferences {
  private value = defaults()
  private writable = true
  private queue: Promise<void> = Promise.resolve()
  constructor(private readonly directory: string) {}
  get() { return { ...this.value } }
  async load() {
    let file: Awaited<ReturnType<typeof open>> | undefined
    try {
      const path = join(this.directory, "side-chat.json"), named = await lstat(path)
      if (!named.isFile() || named.nlink !== 1 || named.size > 16384 || process.platform !== "win32" && (named.uid !== process.getuid?.() || named.mode & 0o077)) throw Error("INVALID_REQUEST")
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      const stat = await file.stat()
      if (stat.dev !== named.dev || stat.ino !== named.ino || stat.size > 16384) throw Error("INVALID_REQUEST")
      const parsed = JSON.parse(await file.readFile("utf8"))
      if (parsed?.version != null && parsed.version !== 1) throw Error("INVALID_REQUEST")
      this.value = normalizeChatPreferences(parsed)
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.writable = false }
    finally { await file?.close() }
    return this.get()
  }
  save(patch: Partial<Omit<ChatPreferences, "version">>) {
    const job = this.queue.catch(() => {}).then(async () => {
      if (!this.writable) throw Error("CHAT_SETTINGS_UNREADABLE")
      const value = normalizeChatPreferences({ ...this.value, ...patch })
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      const temporary = join(this.directory, `side-chat-${randomUUID()}.tmp`)
      try {
        const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        try { await file.writeFile(JSON.stringify(value) + "\n"); await file.sync() } finally { await file.close() }
        await rename(temporary, join(this.directory, "side-chat.json")); this.value = value
      } finally { await unlink(temporary).catch(() => {}) }
    })
    this.queue = job; return job
  }
}
