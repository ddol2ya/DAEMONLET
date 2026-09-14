import { contextBridge, ipcRenderer } from "electron"
import { APP_LANGUAGE_CHANGED, isAppLanguage, languageFromArguments, type AppLanguageApi } from "../shared/app-language"

/** Receive-only language state; does not grant settings or task-control access. */
export function exposeAppLanguage(): void {
  let language = languageFromArguments(process.argv)
  const listeners = new Set<() => void>()
  ipcRenderer.on(APP_LANGUAGE_CHANGED, (_event, value: unknown) => {
    if (!isAppLanguage(value) || value === language) return
    language = value
    for (const listener of [...listeners]) listener()
  })
  const api: AppLanguageApi = {
    current: () => language,
    onChanged(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  contextBridge.exposeInMainWorld("appLanguage", Object.freeze(api))
}
