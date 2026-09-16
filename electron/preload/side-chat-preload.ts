import { contextBridge, ipcRenderer } from "electron"
import { SIDE_CHAT_IPC, type SideChatApi, type SideChatSnapshot } from "../shared/side-chat-contract"
const api: SideChatApi = {
  get: () => ipcRenderer.invoke(SIDE_CHAT_IPC.get),
  action: (action, request) => ipcRenderer.invoke(SIDE_CHAT_IPC.action, action, request),
  onChanged: listener => { const handler = (_: unknown, value: SideChatSnapshot) => listener(value); ipcRenderer.on(SIDE_CHAT_IPC.changed, handler); return () => ipcRenderer.removeListener(SIDE_CHAT_IPC.changed, handler) },
}
contextBridge.exposeInMainWorld("daemonletSideChat", api)
