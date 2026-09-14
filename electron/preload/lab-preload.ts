import { exposeAppLanguage } from "./app-language"
exposeAppLanguage()
import { contextBridge, ipcRenderer } from "electron"
import type { ProtocolClientCommand } from "../../src/protocol/types"
import { IPC, type MotionLabDesktopApi, type ProtocolBridgeStatus, type ProtocolConnectResult } from "../shared/ipc-contract"
import { characterReadApi } from "./character-api"

const subscription = <T>(channel: string, listener: (value: T) => void) => {
  const wrapped = (_event: Electron.IpcRendererEvent, value: T) => listener(value)
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

const connectProtocol = async (): Promise<void> => {
  const result = await ipcRenderer.invoke(IPC.protocolConnect) as ProtocolConnectResult
  if (result.ok) return
  const error = new Error(result.message)
  error.name = result.name
  throw error
}

const api: MotionLabDesktopApi = {
  characters: characterReadApi(),
  platform: process.platform,
  protocol: {
    connect: connectProtocol,
    disconnect: () => ipcRenderer.invoke(IPC.protocolDisconnect) as Promise<void>,
    send: (command: ProtocolClientCommand) => ipcRenderer.send(IPC.protocolSend, command),
    onMessage: (listener) => subscription<string>(IPC.protocolMessage, listener),
    onStatus: (listener) => subscription<ProtocolBridgeStatus>(IPC.protocolStatus, listener),
  },
}

contextBridge.exposeInMainWorld("motionLabDesktop", Object.freeze(api))
