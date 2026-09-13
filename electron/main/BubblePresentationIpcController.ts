import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron"
import { BUBBLE_IPC, validatePetBubblePresentation } from "../shared/bubble-presentation"
import type { ActivityBubbleWindowController } from "./ActivityBubbleWindowController"
import { isTrustedSender } from "./SecurityPolicy"

export class BubblePresentationIpcController {
  private counts = new Map<string, { start: number; count: number }>()
  constructor(private readonly bubble: ActivityBubbleWindowController, private readonly devServerUrl?: string, private readonly now = Date.now) {}
  private accept(event: IpcMainEvent | IpcMainInvokeEvent, role: "pet" | "activity-bubble", limit: number, channel: string): boolean {
    if (!isTrustedSender(event, role === "pet" ? this.bubble.petWindow : this.bubble.window, role, this.devServerUrl)) return false
    const key = `${role}:${channel}`, at = this.now(), old = this.counts.get(key)
    const bucket = !old || at - old.start >= 1000 ? { start: at, count: 0 } : old
    this.counts.set(key, bucket); return ++bucket.count <= limit
  }
  register(): void {
    ipcMain.handle(BUBBLE_IPC.begin, (event, ...args: unknown[]) => {
      if (args.length || !this.accept(event, "pet", 10, "begin")) return 0
      return this.bubble.presentation.begin()
    })
    ipcMain.handle(BUBBLE_IPC.report, (event, ...args: unknown[]) => {
      const report = args.length === 1 ? validatePetBubblePresentation(args[0]) : null
      if (!report || !this.accept(event, "pet", 30, "report")) return { epoch: 0, sequence: 0, granted: false }
      return this.bubble.presentation.report(report)
    })
    ipcMain.on(BUBBLE_IPC.interaction, this.interaction)
    ipcMain.on(BUBBLE_IPC.pointer, this.pointer)
    ipcMain.on(BUBBLE_IPC.height, this.height)
  }
  private interaction = (event: IpcMainEvent, ...args: unknown[]) => {
    if (args.length === 2 && typeof args[0] === "boolean" && typeof args[1] === "boolean" && !(args[1] && !args[0]) && this.accept(event, "activity-bubble", 60, "interaction")) this.bubble.setInteractionLocked(args[0], args[1])
  }
  private pointer = (event: IpcMainEvent, ...args: unknown[]) => {
    if (args.length === 1 && typeof args[0] === "boolean" && this.accept(event, "activity-bubble", 60, "pointer")) this.bubble.setPointerInteractive(args[0])
  }
  private height = (event: IpcMainEvent, ...args: unknown[]) => {
    const height = args[0]
    if (args.length === 1 && typeof height === "number" && Number.isInteger(height) && height >= 44 && height <= 480 && this.accept(event, "activity-bubble", 20, "height")) this.bubble.setContentHeight(height)
  }
  dispose(): void {
    ipcMain.removeHandler(BUBBLE_IPC.begin); ipcMain.removeHandler(BUBBLE_IPC.report)
    ipcMain.removeListener(BUBBLE_IPC.interaction, this.interaction); ipcMain.removeListener(BUBBLE_IPC.pointer, this.pointer); ipcMain.removeListener(BUBBLE_IPC.height, this.height)
    this.counts.clear()
  }
}
