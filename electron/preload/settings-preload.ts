import { exposeAppLanguage } from "./app-language"
exposeAppLanguage()
import { contextBridge, ipcRenderer } from "electron"
import { SETUP_IPC, type SettingsDesktopApi, type SetupResponse } from "../shared/codex-integration-contract"
import { characterManageApi } from "./character-api"

async function request<T>(channel: string, ...payload: unknown[]): Promise<T> {
  const result = await ipcRenderer.invoke(channel, ...payload) as SetupResponse<T>
  if (!result.ok) throw new Error(result.code)
  return result.value
}
const subscription = <T>(channel: string, listener: (value: T) => void) => {
  const wrapped = (_event: Electron.IpcRendererEvent, value: T) => listener(value)
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

import { PACK_UPDATE_IPC, type PackUpdateApi } from "../shared/pack-update-contract"
const api: SettingsDesktopApi = {
  packUpdates: Object.freeze<PackUpdateApi>({ list: () => ipcRenderer.invoke(PACK_UPDATE_IPC.list), act: value => ipcRenderer.invoke(PACK_UPDATE_IPC.act, value), onChanged: listener => subscription(PACK_UPDATE_IPC.changed, listener) }),
  characters: characterManageApi(),
  getStatus: () => request(SETUP_IPC.status),
  refreshStatus: () => request(SETUP_IPC.refresh),
  prepareConnection: () => request(SETUP_IPC.prepare),
  chooseCodexExecutable: () => request(SETUP_IPC.chooseExecutable),
  chooseCodexHome: () => request(SETUP_IPC.chooseHome),
  planHooks: (action) => request(SETUP_IPC.plan, action),
  applyHookPlan: (planId) => request(SETUP_IPC.apply, planId),
  discardHookPlan: () => request(SETUP_IPC.discardPlan),
  runHostSelfTest: () => request(SETUP_IPC.selfTest),
  reportHookReview: () => request(SETUP_IPC.reviewReported),
  startLiveObservation: (surface) => request(SETUP_IPC.observationStart, surface),
  stopLiveObservation: () => request(SETUP_IPC.observationStop),
  reportDesktopStopAttempt: () => request(SETUP_IPC.desktopStopReported),
  dismissOnboarding: (choice) => request(SETUP_IPC.onboardingDismiss, choice),
  getSettings: () => request(SETUP_IPC.settingsGet),
  updateSettings: (patch) => request(SETUP_IPC.settingsPatch, patch),
  setBubblePlacement: action => request(SETUP_IPC.bubblePlacement, action),
  resetPetPosition: () => request(SETUP_IPC.resetPosition),
  restartAdapter: () => request(SETUP_IPC.restartAdapter),
  exportDiagnostics: () => request(SETUP_IPC.exportDiagnostics),
  onStatusChanged: (listener) => subscription(SETUP_IPC.statusChanged, listener),
  onSettingsChanged: (listener) => subscription(SETUP_IPC.settingsChanged, listener),
}
contextBridge.exposeInMainWorld("settingsDesktop", Object.freeze(api))

import { UPDATE_IPC, type UpdateDesktopApi } from "../shared/update-contract"
const updates: UpdateDesktopApi = { onOpen: listener => subscription(UPDATE_IPC.open, listener), snapshot: () => ipcRenderer.invoke(UPDATE_IPC.snapshot), act: value => ipcRenderer.invoke(UPDATE_IPC.action, value), onChanged: listener => subscription(UPDATE_IPC.changed, listener) }
contextBridge.exposeInMainWorld("updateDesktop", Object.freeze(updates))
