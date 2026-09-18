import { applicationInputAllowed } from "./updates/OperationGate"
import { createTranslator } from "../shared/translations"
import { appText, appLanguage } from "./AppLanguage"
import { dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron"
import { CHARACTER_IPC, isCharacterId, isRevision, packErrorCode, type CharacterSelection } from "../shared/character-pack-contract"
import { isTrustedSender } from "./SecurityPolicy"
import type { SettingsWindowController } from "./SettingsWindowController"
import type { CharacterRegistry } from "./CharacterRegistry"
import { characterImportOwner } from "./CharacterImportOwner"

const requestId = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v)
type LocalImport = { document: string; request: string; registryOwner: string; token?: string; timer?: ReturnType<typeof setTimeout>; committing?: boolean }

function selection(value: unknown): CharacterSelection {
  const v = value as CharacterSelection
  if (!v || Object.keys(v).length !== 2 || !isCharacterId(v.id) || v.revision !== "builtin" && !isRevision(v.revision)) throw new Error("PACK_UNAVAILABLE")
  return v
}
export class CharacterIpcController {
  private channels: string[] = []
  private dialogOpen = false
  private rates = new Map<number, { start: number; count: number }>()
  private localImport?: LocalImport
  constructor(private readonly options: {
    registry: CharacterRegistry; settings: SettingsWindowController; pet: () => BrowserWindow | null; lab: () => BrowserWindow | null
    mutationAllowed?: () => boolean; devServerUrl?: string; select: (value: CharacterSelection) => Promise<void>; selected: () => string
  }) {}
  private bind(channel: string, arity: number, mutation: boolean, action: (owner: string, args: unknown[]) => unknown | Promise<unknown>) {
    this.channels.push(channel)
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      const o = this.options, trustedSettings = isTrustedSender(event, o.settings.window, "settings", o.devServerUrl)
      if (!trustedSettings && (mutation || !isTrustedSender(event, o.pet(), "pet", o.devServerUrl) && !isTrustedSender(event, o.lab(), "lab", o.devServerUrl))) return { ok: false, code: "UNTRUSTED_SENDER" }
      if (args.length !== arity) return { ok: false, code: "PACK_TRANSACTION" }
      const now = Date.now(), rate = this.rates.get(event.sender.id)
      if (!rate || now - rate.start > 1000) this.rates.set(event.sender.id, { start: now, count: 1 })
      else if (++rate.count > 24) return { ok: false, code: "PACK_BUSY" }
      const owner = trustedSettings ? o.settings.currentOwner() : String(event.sender.id)
      if (!owner) return { ok: false, code: "PACK_TRANSACTION" }
      if (mutation && (!applicationInputAllowed() || o.mutationAllowed?.() === false)) return { ok: false, code: "PACK_BUSY" }
      try { return { ok: true, value: await action(owner, args) } } catch (error) { return { ok: false, code: packErrorCode(error) } }
    })
  }
  private async nativeDialog<T>(action: () => Promise<T>): Promise<T> {
    if (this.dialogOpen) throw new Error("PACK_BUSY")
    this.dialogOpen = true
    try { return await action() } finally { this.dialogOpen = false }
  }
  private async cancelLocal(document: string, request?: string) {
    const operation = this.localImport
    if (!operation || operation.document !== document || request !== undefined && operation.request !== request) return
    this.localImport = undefined; clearTimeout(operation.timer)
    if (!operation.committing) await this.options.registry.cancelImport(operation.registryOwner)
  }
  /** Actual document retirement, never called merely for a settings tab change. */
  retireOwner(document: string) { return this.cancelLocal(document) }
  register() {
    const o = this.options
    this.bind(CHARACTER_IPC.list, 0, false, () => o.registry.snapshot())
    this.bind(CHARACTER_IPC.select, 1, false, (_owner, [v]) => o.select(selection(v)))
    this.bind(CHARACTER_IPC.choose, 1, true, (owner, [request]) => this.nativeDialog(async () => {
      if (!requestId(request)) throw new Error("PACK_TRANSACTION")
      if (this.localImport) throw new Error("PACK_BUSY")
      const operation: LocalImport = { document: owner, request, registryOwner: characterImportOwner(owner, "local-import") }
      this.localImport = operation
      try {
        const picked = await dialog.showOpenDialog(o.settings.window!, { title: appText("캐릭터 추가"), filters: [{ name: appText("캐릭터 팩"), extensions: ["petchar", "zip"] }], properties: ["openFile"] })
        if (picked.canceled || !picked.filePaths[0]) { await this.cancelLocal(owner, request); return null }
        if (!applicationInputAllowed() || o.settings.currentOwner() !== owner || this.localImport !== operation) throw new Error("PACK_TRANSACTION")
        const preview = await o.registry.prepareImport(picked.filePaths[0], operation.registryOwner, value => {
          if (this.localImport === operation && o.settings.currentOwner() === owner) o.settings.send(CHARACTER_IPC.progress, value)
        })
        if (this.localImport !== operation || o.settings.currentOwner() !== owner) { await o.registry.cancelImport(operation.registryOwner); throw new Error("PACK_TRANSACTION") }
        operation.token = preview.token
        operation.timer = setTimeout(() => { void this.cancelLocal(owner, request) }, Math.max(1, preview.expiresAt - Date.now()))
        return preview
      } catch (error) { if (this.localImport === operation) await this.cancelLocal(owner, request); throw error }
    }))
    this.bind(CHARACTER_IPC.commit, 1, true, async (owner, [token]) => {
      const operation = this.localImport
      if (typeof token !== "string" || token.length !== 36 || !operation || operation.document !== owner || operation.token !== token) throw new Error("PACK_TRANSACTION")
      operation.committing = true; clearTimeout(operation.timer)
      try { return await o.registry.commitImport(token, operation.registryOwner) }
      finally { if (this.localImport === operation) this.localImport = undefined; await o.registry.cancelImport(operation.registryOwner) }
    })
    this.bind(CHARACTER_IPC.cancel, 1, true, (owner, [request]) => { if (!requestId(request)) throw new Error("PACK_TRANSACTION"); return this.cancelLocal(owner, request) })
    for (const [channel, mode] of [[CHARACTER_IPC.remove, "remove"], [CHARACTER_IPC.rollback, "rollback"]] as const) this.bind(channel, 1, true, (owner, [v]) => this.nativeDialog(async () => {
      const target = selection(v), entry = o.registry.get(target.id)
      if (!entry || entry.source !== "external" || entry.revision !== target.revision) throw new Error("PACK_UNAVAILABLE")
      if (mode === "rollback" && !entry.previousVersion) throw new Error("PACK_UNAVAILABLE")
      const result = await dialog.showMessageBox(o.settings.window!, { type: "question", title: mode === "remove" ? appText("캐릭터 제거") : appText("이전 버전 복원"), message: entry.name,
        detail: mode === "remove" ? createTranslator(appLanguage())`${entry.version} 버전과 설치된 이전 버전을 제거합니다. 선택 중이면 기본 제공 캐릭터로 전환합니다.` : createTranslator(appLanguage())`${entry.version} → ${entry.previousVersion} 버전으로 복원합니다.`,
        buttons: [appText("취소"), mode === "remove" ? appText("제거") : appText("복원")], defaultId: 0, cancelId: 0 })
      if (result.response !== 1) return false
      if (!applicationInputAllowed() || o.settings.currentOwner() !== owner) throw new Error("PACK_TRANSACTION")
      if (mode === "remove") {
        if (o.selected() === target.id) await o.select({ id: "gpichan", revision: "builtin" })
        await o.registry.remove(target)
      } else await o.registry.rollback(target)
      return true
    }))
  }
  dispose() { if (this.localImport) void this.retireOwner(this.localImport.document); for (const channel of this.channels) ipcMain.removeHandler(channel); this.channels = []; this.rates.clear() }
}
