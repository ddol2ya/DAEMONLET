import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { isAbsolute, join } from "node:path"
import { hashText } from "../../adapter/codex/hooks/HookLaunchSpec"
import { isObject, parseUniqueJson, MAX_HOOK_FILE_BYTES } from "../../adapter/codex/hooks/HookJson"
import { hasLocalFilePermissions } from "../../adapter/codex/lifecycle/LocalFilePolicy"
import type { CodexSelection } from "../../adapter/codex/doctor/HookSetupDoctor"
import type { PublicSetupStatus } from "../shared/codex-integration-contract"

export type IntegrationSettingsV1 = {
  version: 1
  onboarding: PublicSetupStatus["onboarding"]
  selection: CodexSelection
  reviewedFingerprint: string | null
}
export const defaultIntegrationSettings = (): IntegrationSettingsV1 => ({ version: 1, onboarding: "unseen", selection: { executablePath: null, codexHome: null }, reviewedFingerprint: null })

export class CodexIntegrationStore {
  readonly path: string
  private readonly directory: string
  private value = defaultIntegrationSettings()
  private currentHash = hashText("missing")
  private writable = true
  private saving = Promise.resolve()

  constructor(userData: string) { this.directory = userData; this.path = join(userData, "codex-integration.json") }

  // App preferences are supported on Windows too; Hook installation's POSIX
  // permission policy is deliberately kept separate and unchanged.
  private async read(): Promise<string | null> {
    let file: Awaited<ReturnType<typeof open>> | undefined
    try {
      const named = await lstat(this.path)
      const directory = await lstat(this.directory)
      if (!directory.isDirectory() || directory.isSymbolicLink() || await realpath(this.directory) !== this.directory
        || !named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || !hasLocalFilePermissions(named)) throw new Error("UNSAFE_INTEGRATION_STORE")
      if (named.size > MAX_HOOK_FILE_BYTES) throw new Error("FILE_TOO_LARGE")
      file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW)
      const stat = await file.stat(), afterOpen = await lstat(this.path)
      const same = (a: typeof stat, b: typeof stat) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode && a.nlink === b.nlink
      if (!same(named, stat) || !same(afterOpen, stat) || afterOpen.isSymbolicLink()) throw new Error("INTEGRATION_STORE_CHANGED")
      const buffer = Buffer.alloc(Math.min(MAX_HOOK_FILE_BYTES + 1, stat.size + 1))
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      const after = await file.stat(), pathAfter = await lstat(this.path)
      if (!same(stat, pathAfter) || bytesRead !== stat.size || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) throw new Error("INTEGRATION_STORE_CHANGED")
      return buffer.subarray(0, bytesRead).toString("utf8")
    } catch (error) {
      if (!file && (error as NodeJS.ErrnoException).code === "ENOENT") return null
      throw error
    } finally { await file?.close() }
  }

  async load(): Promise<{ value: IntegrationSettingsV1; issue: string | null }> {
    try {
      const text = await this.read()
      this.currentHash = hashText(text ?? "missing")
      if (text === null) return { value: this.get(), issue: null }
      const parsed = parseUniqueJson(text)
      if (!isObject(parsed) || parsed.version !== 1 || !["unseen", "shown", "skipped", "acknowledged"].includes(String(parsed.onboarding)) || !isObject(parsed.selection)) throw new Error("INVALID_INTEGRATION_SETTINGS")
      const validPath = (value: unknown) => value === null || typeof value === "string" && isAbsolute(value) && value.length <= 4096 && !/[\0\r\n]/.test(value)
      if (!validPath(parsed.selection.executablePath) || !validPath(parsed.selection.codexHome)
        || parsed.reviewedFingerprint !== null && (typeof parsed.reviewedFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(parsed.reviewedFingerprint))) throw new Error("INVALID_INTEGRATION_SETTINGS")
      this.value = { version: 1, onboarding: parsed.onboarding as PublicSetupStatus["onboarding"], selection: { executablePath: parsed.selection.executablePath as string | null, codexHome: parsed.selection.codexHome as string | null }, reviewedFingerprint: parsed.reviewedFingerprint as string | null }
      return { value: this.get(), issue: null }
    } catch {
      // A future/corrupt store is retained for review. Do not reset a user's
      // selection or mark onboarding complete by overwriting unknown data.
      this.writable = false
      return { value: this.get(), issue: "INTEGRATION_STORE_UNREADABLE" }
    }
  }

  get(): IntegrationSettingsV1 { return structuredClone(this.value) }

  save(next: IntegrationSettingsV1): Promise<void> {
    const save = this.saving.catch(() => {}).then(async () => {
      if (!this.writable) throw new Error("INTEGRATION_STORE_UNREADABLE")
      const before = await this.read()
      if (hashText(before ?? "missing") !== this.currentHash) throw new Error("INTEGRATION_STORE_CHANGED")
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      const directory = await lstat(this.directory)
      if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== (process.getuid?.() ?? 0) || await realpath(this.directory) !== this.directory) throw new Error("UNSAFE_INTEGRATION_STORE")
      const temporary = `${this.path}.tmp-${randomUUID()}`
      const contents = `${JSON.stringify(next, null, 2)}\n`
      try {
        const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        try { await file.writeFile(contents); await file.sync() } finally { await file.close() }
        await rename(temporary, this.path)
        this.currentHash = hashText(contents)
        this.value = structuredClone(next)
      } finally { await unlink(temporary).catch(() => {}) }
    })
    this.saving = save
    return save
  }
  async flush(): Promise<void> { await this.saving.catch(() => {}) }
}
