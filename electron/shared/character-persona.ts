/** Pack data only. These fields never grant permissions or select a model. */
export type CharacterPersona = {
  schemaVersion: 1
  identity: { role: string; traits: string[]; background: string }
  speech: { formality: "casual" | "polite" | "formal"; defaultLength: "brief"; humor: "none" | "light" | "dry"; languagePolicy: "follow-app"; addressTerm: string; styleNotes: string[] }
  examples: Array<{ user: string; reply: string }>
}
export const PERSONA_MAX_BYTES = 16 * 1024
const fail = (): never => { throw new Error("PACK_PERSONA") }
const utf8 = (s: string) => new TextEncoder().encode(s).byteLength
function object(value: unknown, allowed: string[], required: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail()
  const v = value as Record<string, unknown>
  if (Object.keys(v).some(k => !allowed.includes(k)) || required.some(k => !Object.hasOwn(v, k))) fail()
  return v
}
function text(value: unknown, max: number, optional = false): string {
  if (typeof value !== "string") return fail()
  // Permit tab/newline; reject C0/C1 controls, bidi overrides and lone surrogates.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value) || /[\ud800-\udfff]/u.test(value)) fail()
  const s = value.replace(/\r\n?/g, "\n").replace(/\t/g, " ").normalize("NFC").trim()
  if ((!optional && !s) || Array.from(s).length > max) fail()
  return s
}
function list(value: unknown, max: number, length: number): string[] {
  if (!Array.isArray(value) || value.length > max) return fail()
  return value.map(v => text(v, length))
}
function choice<T extends string>(value: unknown, values: readonly T[]): T {
  if (!values.includes(value as T)) return fail()
  return value as T
}
export function validateCharacterPersona(value: unknown): CharacterPersona {
  // Bound in-memory callers as well as byte/file callers; never return raw data.
  try { if (utf8(JSON.stringify(value)) > PERSONA_MAX_BYTES) fail() } catch { fail() }
  const v = object(value, ["schemaVersion", "identity", "speech", "examples"], ["schemaVersion", "identity", "speech", "examples"])
  if (v.schemaVersion !== 1) fail()
  const i = object(v.identity, ["role", "traits", "background"], ["role", "traits"])
  const s = object(v.speech, ["formality", "defaultLength", "humor", "languagePolicy", "addressTerm", "styleNotes"], ["formality", "defaultLength", "humor", "languagePolicy"])
  if (!Array.isArray(v.examples) || v.examples.length > 6) fail()
  return {
    schemaVersion: 1,
    identity: { role: text(i.role, 240), traits: list(i.traits, 8, 120), background: text(i.background === undefined ? "" : i.background, 1200, true) },
    speech: { formality: choice(s.formality, ["casual", "polite", "formal"]), defaultLength: choice(s.defaultLength, ["brief"]), humor: choice(s.humor, ["none", "light", "dry"]), languagePolicy: choice(s.languagePolicy, ["follow-app"]), addressTerm: text(s.addressTerm === undefined ? "" : s.addressTerm, 40, true), styleNotes: list(s.styleNotes === undefined ? [] : s.styleNotes, 4, 160) },
    examples: (v.examples as unknown[]).map(example => { const e = object(example, ["user", "reply"], ["user", "reply"]); return { user: text(e.user, 400), reply: text(e.reply, 400) } }),
  }
}
export function parseCharacterPersona(bytes: Uint8Array): CharacterPersona {
  if (bytes.byteLength > PERSONA_MAX_BYTES) fail()
  try { return validateCharacterPersona(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))) } catch { return fail() }
}
export const neutralPersona = (): CharacterPersona => validateCharacterPersona({ schemaVersion: 1, identity: { role: "Desktop conversation companion", traits: [] }, speech: { formality: "polite", defaultLength: "brief", humor: "none", languagePolicy: "follow-app" }, examples: [] })
