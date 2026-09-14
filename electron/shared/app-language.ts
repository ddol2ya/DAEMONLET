export const APP_LANGUAGES = ["ko", "en"] as const
export type AppLanguage = typeof APP_LANGUAGES[number]
export const APP_LANGUAGE_CHANGED = "app.language.changed"
export const isAppLanguage = (value: unknown): value is AppLanguage => value === "ko" || value === "en"
export const normalizeAppLanguage = (value: unknown): AppLanguage => isAppLanguage(value) ? value : "ko"
export const languageLocale = (language: AppLanguage): string => language === "en" ? "en-US" : "ko-KR"
export function languageFromArguments(args: readonly string[]): AppLanguage {
  const selected = args.filter(value => /^--daemonlet-language=(ko|en)$/.test(value)).at(-1)
  return normalizeAppLanguage(selected?.split("=")[1])
}

export type AppLanguageApi = {
  current(): AppLanguage
  onChanged(listener: () => void): () => void
}

declare global { interface Window { appLanguage?: AppLanguageApi } }
