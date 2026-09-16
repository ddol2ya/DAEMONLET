import { ipcMain, type IpcMainInvokeEvent } from "electron"
import { UPDATE_IPC, parseUpdateAction } from "../../shared/update-contract"
import { isTrustedSender } from "../SecurityPolicy"
import type { SettingsWindowController } from "../SettingsWindowController"
import type { UpdateService } from "./UpdateService"
export class UpdateIpcController {
  private unsubscribe?: () => void
  private bucket = { at: 0, count: 0 }
  constructor(private readonly service: UpdateService, private readonly window: SettingsWindowController, private readonly devServerUrl?: string) {}
  open() {
    const win = this.window.open()
    if (win.webContents.isLoading()) win.webContents.once("did-finish-load", () => this.window.send(UPDATE_IPC.open, null))
    else this.window.send(UPDATE_IPC.open, null)
  }
  register() {
    const check = (event: IpcMainInvokeEvent) => {
      if (!isTrustedSender(event, this.window.window, "settings", this.devServerUrl, true)) throw Error("UNTRUSTED_SENDER")
      const now = Date.now(); if (now - this.bucket.at >= 1000) this.bucket = { at: now, count: 0 }
      if (++this.bucket.count > 12) throw Error("REQUEST_LIMITED")
    }
    ipcMain.handle(UPDATE_IPC.snapshot, (event, ...args) => { check(event); if (args.length) throw Error("INVALID_REQUEST"); return this.service.snapshot() })
    ipcMain.handle(UPDATE_IPC.action, (event, value, ...extra) => { check(event); const action = parseUpdateAction(value); if (extra.length || !action) throw Error("INVALID_REQUEST"); return this.service.act(action) })
    this.unsubscribe = this.service.subscribe(value => this.window.send(UPDATE_IPC.changed, value))
  }
  dispose() { this.unsubscribe?.(); ipcMain.removeHandler(UPDATE_IPC.snapshot); ipcMain.removeHandler(UPDATE_IPC.action) }
}
