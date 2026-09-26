import { exposeAppLanguage } from "./app-language"
exposeAppLanguage()
import { contextBridge, ipcRenderer } from "electron"
import { ACTIVITY_IPC, type ActivityApi, type ActivitySnapshot } from "../shared/activity-contract"
import { BUBBLE_IPC } from "../shared/bubble-presentation"
import "./side-chat-preload"
import { PLACEMENT_IPC, type BubblePlacementApi } from "../shared/bubble-placement"

const placement: BubblePlacementApi = {
  get: () => ipcRenderer.invoke(PLACEMENT_IPC.get), action: value => ipcRenderer.invoke(PLACEMENT_IPC.action, value),
  onChanged: listener => { const handler = (_event: Electron.IpcRendererEvent, value: Parameters<typeof listener>[0]) => listener(value); ipcRenderer.on(PLACEMENT_IPC.changed, handler); return () => ipcRenderer.removeListener(PLACEMENT_IPC.changed, handler) },
}
contextBridge.exposeInMainWorld("bubblePlacementDesktop", placement)

const api: ActivityApi = {
  getSnapshot: () => ipcRenderer.invoke(ACTIVITY_IPC.get),
  acknowledge: request => ipcRenderer.invoke(ACTIVITY_IPC.acknowledge, request),
  openResult: target => ipcRenderer.invoke(ACTIVITY_IPC.openResult, target),
  openCodex: () => ipcRenderer.invoke(ACTIVITY_IPC.openCodex),
  openConversation: target => ipcRenderer.invoke(ACTIVITY_IPC.openConversation, target),
  openChat: target => ipcRenderer.invoke(ACTIVITY_IPC.openChat, target),
  openList: () => ipcRenderer.invoke(ACTIVITY_IPC.openList),
  setCollapsed: value => ipcRenderer.invoke(ACTIVITY_IPC.setCollapsed, value),
  setInteractionLocked: (value, pressed = false) => ipcRenderer.send(BUBBLE_IPC.interaction, value, pressed),
  onInteractionStarted: listener => {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown) => { if (value === true) listener() }
    ipcRenderer.on(BUBBLE_IPC.interaction, handler)
    return () => ipcRenderer.removeListener(BUBBLE_IPC.interaction, handler)
  },
  setPointerInteractive: value => ipcRenderer.send(BUBBLE_IPC.pointer, value),
  reportHeight: value => ipcRenderer.send(BUBBLE_IPC.height, value),
  onChanged: listener => {
    const handler = (_event: Electron.IpcRendererEvent, value: ActivitySnapshot) => listener(value)
    ipcRenderer.on(ACTIVITY_IPC.changed, handler)
    return () => ipcRenderer.removeListener(ACTIVITY_IPC.changed, handler)
  },
}
contextBridge.exposeInMainWorld("activityDesktop", api)

import { TASK_CONTROL_IPC, type TaskControlApi, type TaskControlSnapshot, type DictationSnapshot } from "../shared/task-control-contract"
const subscribe = <T>(channel: string, listener: (value: T) => void) => {
  const handler = (_event: Electron.IpcRendererEvent, value: T) => listener(value)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}
const control: TaskControlApi = {
  openConversation: key => ipcRenderer.invoke(TASK_CONTROL_IPC.openConversation, key),
  getSnapshot: () => ipcRenderer.invoke(TASK_CONTROL_IPC.get),
  getView: () => ipcRenderer.invoke(TASK_CONTROL_IPC.getView),
  connect: path => ipcRenderer.invoke(TASK_CONTROL_IPC.connect, path),
  connectDesktop: () => ipcRenderer.invoke(TASK_CONTROL_IPC.connectDesktop),
  disconnect: () => ipcRenderer.invoke(TASK_CONTROL_IPC.disconnect),
  refresh: () => ipcRenderer.invoke(TASK_CONTROL_IPC.refresh),
  select: key => ipcRenderer.invoke(TASK_CONTROL_IPC.select, key),
  send: value => ipcRenderer.invoke(TASK_CONTROL_IPC.send, value),
  stop: value => ipcRenderer.invoke(TASK_CONTROL_IPC.stop, value),
  setView: (view, collapsed) => ipcRenderer.invoke(TASK_CONTROL_IPC.view, view, collapsed),
  startDictation: sessionId => ipcRenderer.invoke(TASK_CONTROL_IPC.dictationStart, sessionId),
  stopDictation: sessionId => ipcRenderer.invoke(TASK_CONTROL_IPC.dictationStop, sessionId),
  onChanged: listener => subscribe<TaskControlSnapshot>(TASK_CONTROL_IPC.changed, listener),
  onDictation: listener => subscribe<DictationSnapshot>(TASK_CONTROL_IPC.dictation, listener),
  onViewChanged: listener => subscribe(TASK_CONTROL_IPC.viewChanged, listener),
}
contextBridge.exposeInMainWorld("taskControlDesktop", control)

import { CODEX_USAGE_IPC, type CodexUsageApi, type CodexUsageSnapshot } from "../shared/codex-usage-contract"
const usage: CodexUsageApi = {
  getSnapshot: () => ipcRenderer.invoke(CODEX_USAGE_IPC.get),
  refresh: () => ipcRenderer.invoke(CODEX_USAGE_IPC.refresh),
  onChanged: listener => subscribe<CodexUsageSnapshot>(CODEX_USAGE_IPC.changed, listener),
}
contextBridge.exposeInMainWorld("codexUsageDesktop", usage)
