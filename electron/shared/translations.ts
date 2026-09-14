import { languageLocale, type AppLanguage } from "./app-language"
import englishMessages from "./messages.en.json"

// Korean source messages are stable lookup keys. Values are interpolated only
// after lookup, so user-authored titles, paths and dialogue are never translated.
export const ENGLISH_MESSAGES: Readonly<Record<string, string>> = Object.freeze(englishMessages)

export type AppMessage = { key: string; values: unknown[] }
/** Store application-owned messages, not translated text, in async UI state. */
export function message(parts: TemplateStringsArray, ...values: unknown[]): AppMessage {
  return { key: parts.reduce((text, part, index) => text + (index ? `{${index - 1}}` : "") + part, ""), values }
}

export interface Translator {
  readonly language: AppLanguage
  readonly locale: string
  (message: string | AppMessage): string
  (parts: TemplateStringsArray, ...values: unknown[]): string
}
export function createTranslator(language: AppLanguage): Translator {
  const translate = (input: string | AppMessage | TemplateStringsArray, ...values: unknown[]): string => {
    const plain = typeof input === "string"
    const stored = plain ? { key: input, values: [] } : Array.isArray(input) ? message(input as unknown as TemplateStringsArray, ...values) : input as AppMessage
    const { key } = stored
    const translated = language === "en" && Object.hasOwn(ENGLISH_MESSAGES, key) ? ENGLISH_MESSAGES[key] : key
    return plain ? translated : translated.replace(/\{(\d+)\}/g, (match, index: string) => Number(index) < stored.values.length ? String(stored.values[Number(index)]) : match)
  }
  return Object.assign(translate, { language, locale: languageLocale(language) })
}
