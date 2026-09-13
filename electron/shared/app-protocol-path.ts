import { resolve, sep } from "node:path"

export function filePathForAppUrl(value: string, distRoot: string): string | null {
  const match = /^pet:\/\/([^/?#]+)(\/[^?#]*)?(?:[?#].*)?$/.exec(value)
  if (!match || match[1] !== "app") return null
  const rawPath = match[2] ?? "/"
  if (rawPath.startsWith("//") || /^\/[A-Za-z]:/.test(rawPath)) return null
  if (/%00|%2e|%2f|%5c/i.test(rawPath)) return null
  let decoded: string
  try { decoded = decodeURIComponent(rawPath) } catch { return null }
  if (/%00|%2e|%2f|%5c/i.test(decoded)) return null
  if (decoded.includes("\0") || decoded.includes("\\") || !decoded.startsWith("/")) return null
  const segments = decoded.split("/")
  if (segments.some((segment) => segment === ".." || segment === ".")) return null
  const relative = decoded === "/" ? "index.html" : decoded.slice(1)
  const root = resolve(distRoot)
  const candidate = resolve(root, relative)
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return null
  return candidate
}
