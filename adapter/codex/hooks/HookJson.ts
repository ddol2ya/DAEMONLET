export type JsonObject = { [key: string]: unknown }
export type HookGroup = JsonObject & { hooks: JsonObject[] }
export type HooksFile = JsonObject & { hooks?: Record<string, HookGroup[]> }
export const MAX_HOOK_FILE_BYTES = 1024 * 1024
export const isObject = (value: unknown): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value)

// JSON.parse accepts duplicate keys. Scan the JSON grammar first so preview and
// Codex cannot interpret different values for the same (also escaped) key.
export function parseUniqueJson(text: string): unknown {
  if (Buffer.byteLength(text) > MAX_HOOK_FILE_BYTES) throw new Error("FILE_TOO_LARGE")
  let index = 0
  const whitespace = () => { while (/[\t\r\n ]/.test(text[index] ?? "x")) index++ }
  const string = (): string => {
    const start = index++
    while (index < text.length) {
      const character = text[index++]
      if (character === "\\") index++
      else if (character === '"') return JSON.parse(text.slice(start, index)) as string
    }
    throw new Error("INVALID_JSON")
  }
  const value = (depth: number): void => {
    if (depth > 64) throw new Error("JSON_TOO_DEEP")
    whitespace()
    const first = text[index]
    if (first === '"') { string(); return }
    if (first === "{" || first === "[") {
      index++
      const end = first === "{" ? "}" : "]"
      const keys = new Set<string>()
      whitespace()
      if (text[index] === end) { index++; return }
      while (index < text.length) {
        if (first === "{") {
          whitespace()
          if (text[index] !== '"') throw new Error("INVALID_JSON")
          const key = string()
          if (keys.has(key)) throw new Error("DUPLICATE_JSON_KEY")
          keys.add(key)
          whitespace()
          if (text[index++] !== ":") throw new Error("INVALID_JSON")
        }
        value(depth + 1)
        whitespace()
        const next = text[index++]
        if (next === end) return
        if (next !== ",") throw new Error("INVALID_JSON")
      }
      throw new Error("INVALID_JSON")
    }
    const literal = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(index))
    if (!literal) throw new Error("INVALID_JSON")
    if (/^-?\d/.test(literal[0])) {
      const number = Number(literal[0])
      if (!Number.isFinite(number) || Number.isInteger(number) && !Number.isSafeInteger(number)) throw new Error("UNSAFE_JSON_NUMBER")
    }
    index += literal[0].length
  }
  try {
    value(0)
    whitespace()
    if (index !== text.length) throw new Error("INVALID_JSON")
    return JSON.parse(text) as unknown
  } catch (error) {
    if (error instanceof Error && ["DUPLICATE_JSON_KEY", "JSON_TOO_DEEP", "UNSAFE_JSON_NUMBER"].includes(error.message)) throw error
    throw new Error("INVALID_JSON")
  }
}

export function parseHooksFile(text: string | null): HooksFile {
  try {
    const value = text === null ? {} : parseUniqueJson(text)
    if (!isObject(value)) throw new Error("root must be an object")
    if (value.hooks !== undefined) {
      if (!isObject(value.hooks)) throw new Error("hooks must be an object")
      for (const groups of Object.values(value.hooks)) {
        if (!Array.isArray(groups)) throw new Error("every hook event must be an array")
        if (groups.some((group) => !isObject(group) || !Array.isArray(group.hooks) || group.hooks.some((hook) => !isObject(hook)))) throw new Error("every matcher group must contain handler objects")
      }
    }
    return value as HooksFile
  } catch (error) {
    const code = error instanceof Error ? error.message : "INVALID_JSON"
    throw new Error(`refusing to modify invalid hooks.json: ${code}`)
  }
}
