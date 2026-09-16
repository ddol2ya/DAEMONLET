import { applicationInputAllowed } from "./updates/OperationGate"
import { createTranslator } from "../shared/translations"
import { appText, appLanguage } from "./AppLanguage"
import { dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron"
import { CHARACTER_IPC, isCharacterId, isRevision, packErrorCode, type CharacterSelection } from "../shared/character-pack-contract"
import { isTrustedSender } from "./SecurityPolicy"
import type { SettingsWindowController } from "./SettingsWindowController"
import type { CharacterRegistry } from "./CharacterRegistry"

function selection(value: unknown): CharacterSelection {
  const v = value as CharacterSelection
  if (!v || Object.keys(v).length !== 2 || !isCharacterId(v.id) || v.revision !== "builtin" && !isRevision(v.revision)) throw new Error("PACK_UNAVAILABLE")
  return v
}
export class CharacterIpcController {
  private channels: string[] = []
  private dialogOpen = false
  private rates = new Map<number, { start: number; count: number }>()
  constructor(private readonly options: {
    registry: CharacterRegistry; settings: SettingsWindowController; pet: () => BrowserWindow | null; lab: () => BrowserWindow | null
    devServerUrl?: string; select: (value: CharacterSelection) => Promise<void>; selected: () => string
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
      try { return { ok: true, value: await action(owner, args) } } catch (error) { return { ok: false, code: packErrorCode(error) } }
    })
  }
  private async nativeDialog<T>(action: () => Promise<T>): Promise<T> {
    if (this.dialogOpen) throw new Error("PACK_BUSY")
    this.dialogOpen = true
    try { return await action() } finally { this.dialogOpen = false }
  }
  register() {
    const o = this.options
    this.bind(CHARACTER_IPC.list, 0, false, () => o.registry.snapshot())
    this.bind(CHARACTER_IPC.select, 1, false, (_owner, [v]) => o.select(selection(v)))
    this.bind(CHARACTER_IPC.choose, 0, true, owner => this.nativeDialog(async () => {
      const picked = await dialog.showOpenDialog(o.settings.window!, { title: appText("캐릭터 추가"), filters: [{ name: appText("캐릭터 팩"), extensions: ["petchar", "zip"] }], properties: ["openFile"] })
      if (picked.canceled || !picked.filePaths[0]) return null
      if (!applicationInputAllowed() || o.settings.currentOwner() !== owner) throw new Error("PACK_TRANSACTION")
      return o.registry.prepareImport(picked.filePaths[0], owner, value => {
        if (o.settings.currentOwner() === owner) o.settings.send(CHARACTER_IPC.progress, value)
      })
    }))
    this.bind(CHARACTER_IPC.commit, 1, true, (owner, [token]) => {
      if (typeof token !== "string" || token.length !== 36) throw new Error("PACK_TRANSACTION")
      return o.registry.commitImport(token, owner)
    })
    this.bind(CHARACTER_IPC.cancel, 0, true, owner => o.registry.cancelImport(owner))
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
  dispose() { for (const channel of this.channels) ipcMain.removeHandler(channel); this.channels = []; this.rates.clear() }
}
