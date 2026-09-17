import { ipcMain } from "electron"
import { isCharacterId } from "../../shared/character-pack-contract"
import { PACK_UPDATE_IPC, type PackUpdateAction } from "../../shared/pack-update-contract"
import { isTrustedSender } from "../SecurityPolicy"
import type { SettingsWindowController } from "../SettingsWindowController"
import type { PackUpdateService } from "./PackUpdateService"

export function parsePackUpdateAction(value: unknown): PackUpdateAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("PACK_TRANSACTION")
  const v = value as PackUpdateAction
  if (v.action === "apply") {
    if (Object.keys(v).length !== 2 || typeof v.candidateId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v.candidateId)) throw Error("PACK_TRANSACTION")
  } else if (!["check", "download", "cancel", "skip", "auto"].includes(v.action) || !isCharacterId(v.packId) || Object.keys(v).length !== (v.action === "auto" ? 3 : 2) || v.action === "auto" && typeof v.enabled !== "boolean") throw Error("PACK_TRANSACTION")
  return v
}
export class PackUpdateIpcController {
  private bucket = { at: 0, count: 0 }
  constructor(private readonly service: PackUpdateService, private readonly settings: SettingsWindowController, private readonly devServerUrl?: string) {}
  register() {
    for (const channel of [PACK_UPDATE_IPC.list, PACK_UPDATE_IPC.act]) ipcMain.handle(channel, async (event, ...args) => {
      if (!isTrustedSender(event, this.settings.window, "settings", this.devServerUrl, true)) throw Error("UNTRUSTED_SENDER")
      const owner = this.settings.currentOwner()
      if (!owner) throw Error("PACK_TRANSACTION")
      if (Date.now() - this.bucket.at >= 1000) this.bucket = { at: Date.now(), count: 0 }
      if (++this.bucket.count > 16) throw Error("PACK_BUSY")
      if (channel === PACK_UPDATE_IPC.list) { if (args.length) throw Error("PACK_TRANSACTION"); return this.service.snapshot() }
      if (args.length !== 1) throw Error("PACK_TRANSACTION")
      const v = parsePackUpdateAction(args[0])
      switch (v.action) {
        case "check": return this.service.check(v.packId, owner)
        case "download": return this.service.download(v.packId, owner)
        case "cancel": return this.service.cancel(owner, v.packId)
        case "skip": return this.service.skip(v.packId, owner)
        case "auto": return this.service.auto(v.packId, v.enabled, owner)
        case "apply": return this.service.apply(v.candidateId, owner)
      }
    })
  }
  dispose() { ipcMain.removeHandler(PACK_UPDATE_IPC.list); ipcMain.removeHandler(PACK_UPDATE_IPC.act) }
}
