import { PACK_LIMITS, isCharacterId, isRevision } from "./character-pack-contract"

/** ZIP names are stricter than relative references. No percent decoding is permitted. */
export function validatePackPath(value: unknown): string {
  if (typeof value !== "string" || new TextEncoder().encode(value).length > PACK_LIMITS.pathBytes || value !== value.normalize("NFC") || /[\\:%?#\u0000-\u001f\u007f]/.test(value)) throw new Error("PACK_PATH")
  const parts = value.split("/")
  if (parts.length > PACK_LIMITS.pathDepth || parts.some(p => !p || p === "." || p === ".." || /[. ]$/.test(p) || /^[ .]/.test(p) || /[<>"|*]/.test(p) || /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(p))) throw new Error("PACK_PATH")
  return value
}
export function resolvePackReference(reference: unknown, from: string, inventory?: ReadonlySet<string>): string {
  if (typeof reference !== "string" || !reference || reference.startsWith("/") || /[\\:%?#\u0000-\u001f\u007f]/.test(reference)) throw new Error("PACK_PATH")
  const parts = from.split("/").slice(0, -1)
  for (const part of reference.split("/")) {
    if (part === "..") { if (!parts.length) throw new Error("PACK_PATH"); parts.pop() }
    else if (part === ".") continue
    else { if (!part) throw new Error("PACK_PATH"); parts.push(part) }
  }
  const result = validatePackPath(parts.join("/"))
  if (inventory && !inventory.has(result)) throw new Error("PACK_INTEGRITY")
  return result
}
export const packAssetUrl = (id: string, revision: string, path: string) => `pet://app/character-packs/${id}/${revision}/${path.split("/").map(encodeURIComponent).join("/")}`
export function parsePackAssetUrl(value: string): { id: string; revision: string; path: string } | null {
  const match = /^pet:\/\/app\/character-packs\/([^/]+)\/([^/]+)\/([^?#]+)$/.exec(value)
  if (!match || !isCharacterId(match[1]) || !isRevision(match[2]) || /%2e|%2f|%5c|%25/i.test(match[3])) return null
  try { return { id: match[1], revision: match[2], path: validatePackPath(decodeURIComponent(match[3])) } } catch { return null }
}
