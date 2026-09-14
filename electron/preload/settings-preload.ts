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

const api: SettingsDesktopApi = {
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
  resetPetPosition: () => request(SETUP_IPC.resetPosition),
  restartAdapter: () => request(SETUP_IPC.restartAdapter),
  exportDiagnostics: () => request(SETUP_IPC.exportDiagnostics),
  onStatusChanged: (listener) => subscription(SETUP_IPC.statusChanged, listener),
  onSettingsChanged: (listener) => subscription(SETUP_IPC.settingsChanged, listener),
}
contextBridge.exposeInMainWorld("settingsDesktop", Object.freeze(api))
