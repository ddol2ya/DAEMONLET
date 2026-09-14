import type { BrowserWindow } from "electron"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { APP_LANGUAGE_CHANGED, normalizeAppLanguage, type AppLanguage } from "../shared/app-language"
import { createTranslator } from "../shared/translations"

let current: AppLanguage = "ko"
const windows = new Map<BrowserWindow, string | undefined>()
export const appLanguage = () => current
export const languageArguments = () => [`--daemonlet-language=${current}`]
export const appText = (message: string) => createTranslator(current)(message)

/** Read only the locale before the splash; registry-dependent migration stays in WindowBoundsStore. */
export async function readSavedAppLanguage(userData: string): Promise<AppLanguage> {
  try { return normalizeAppLanguage(JSON.parse(await readFile(join(userData, "desktop-settings.json"), "utf8"))?.language) }
  catch { return "ko" }
}
function send(win: BrowserWindow, title?: string): void {
  if (win.isDestroyed()) { windows.delete(win); return }
  win.webContents.send(APP_LANGUAGE_CHANGED, current)
  if (title) win.setTitle(appText(title))
}
export function bindWindowLanguage(win: BrowserWindow, title?: string): void {
  windows.set(win, title)
  win.webContents.on("did-finish-load", () => send(win, title))
  win.once("closed", () => { windows.delete(win) })
}
export function setAppLanguage(language: AppLanguage): void {
  current = normalizeAppLanguage(language)
  for (const [win, title] of windows) send(win, title)
}
