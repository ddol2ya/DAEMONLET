import { useEffect, useMemo, useSyncExternalStore } from "react"
import { createTranslator } from "../../electron/shared/translations"
import type { AppLanguage } from "../../electron/shared/app-language"

const subscribe = (listener: () => void) => window.appLanguage?.onChanged(listener) ?? (() => {})
const current = (): AppLanguage => window.appLanguage?.current() ?? "ko"
export function useAppLanguage(): AppLanguage {
  const language = useSyncExternalStore(subscribe, current, () => "ko" as const)
  useEffect(() => { document.documentElement.lang = language }, [language])
  return language
}
export function useT() {
  const language = useAppLanguage()
  return useMemo(() => createTranslator(language), [language])
}
