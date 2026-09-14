import { exposeAppLanguage } from "./app-language"
exposeAppLanguage()
import { contextBridge, ipcRenderer } from "electron"
import { IPC, type AdapterStatus, type PetDesktopApi, type ProtocolBridgeStatus, type ProtocolConnectResult, type SanitizedAdapterDiagnostics } from "../shared/ipc-contract"
import type { DesktopSettingsPatch, DesktopSettingsV1 } from "../shared/desktop-settings"
import type { ProtocolClientCommand } from "../../src/protocol/types"
import { characterReadApi } from "./character-api"
import { CHARACTER_IPC } from "../shared/character-pack-contract"
import { BUBBLE_IPC } from "../shared/bubble-presentation"

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

const api: PetDesktopApi = {
  bubble: { begin: () => ipcRenderer.invoke(BUBBLE_IPC.begin), report: value => ipcRenderer.invoke(BUBBLE_IPC.report, value) },
  characters: characterReadApi(),
  reportCharacterLoadFailure: selection => ipcRenderer.send(CHARACTER_IPC.loadFailed, selection),
  getSettings: () => ipcRenderer.invoke(IPC.settingsGet) as Promise<DesktopSettingsV1>,
  updateSettings: (patch: DesktopSettingsPatch) => ipcRenderer.invoke(IPC.settingsPatch, patch) as Promise<DesktopSettingsV1>,
  setLayoutMode: (enabled: boolean) => ipcRenderer.invoke(IPC.layoutSet, enabled) as Promise<void>,
  resetPosition: () => ipcRenderer.invoke(IPC.resetPosition) as Promise<void>,
  setMousePassthrough: (ignore: boolean) => ipcRenderer.invoke(IPC.mousePassthrough, ignore) as Promise<void>,
  setInteractionLocked: (locked: boolean) => ipcRenderer.send(IPC.interactionLock, locked),
  reportReady: (info) => ipcRenderer.send(IPC.petReady, info),
  reportAlphaFailure: (message: string) => ipcRenderer.send(IPC.alphaFailure, message),
  restartAdapter: () => ipcRenderer.invoke(IPC.adapterRestart) as Promise<void>,
  getAdapterDiagnostics: () => ipcRenderer.invoke(IPC.adapterDiagnostics) as Promise<SanitizedAdapterDiagnostics>,
  reloadPet: () => ipcRenderer.invoke(IPC.petReload) as Promise<void>,
  onSettingsChanged: (listener) => subscription<DesktopSettingsV1>(IPC.settingsChanged, listener),
  onAdapterStatus: (listener) => subscription<AdapterStatus>(IPC.adapterStatus, listener),
  onLayoutChanged: (listener) => subscription<boolean>(IPC.layoutChanged, listener),
  onPointerOutside: (listener) => subscription<boolean>(IPC.pointerOutside, outside => { if (outside === true) listener() }),
  protocol: {
    connect: connectProtocol,
    disconnect: () => ipcRenderer.invoke(IPC.protocolDisconnect) as Promise<void>,
    send: (command: ProtocolClientCommand) => ipcRenderer.send(IPC.protocolSend, command),
    onMessage: (listener) => subscription<string>(IPC.protocolMessage, listener),
    onStatus: (listener) => subscription<ProtocolBridgeStatus>(IPC.protocolStatus, listener),
  },
}

contextBridge.exposeInMainWorld("petDesktop", Object.freeze(api))
