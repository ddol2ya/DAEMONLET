import { readFile } from "node:fs/promises"
import { extname } from "node:path"
import { protocol, type Protocol } from "electron"
import { filePathForAppUrl } from "../shared/app-protocol-path"
import { parsePackAssetUrl } from "../shared/character-pack-path"
import type { CharacterRegistry } from "./CharacterRegistry"

export { filePathForAppUrl } from "../shared/app-protocol-path"

export const APP_SCHEME = "pet"

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".psd": "application/octet-stream",
  ".woff2": "font/woff2",
}

export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }])
}

export function installAppProtocol(distRoot: string, instance: Protocol = protocol, registry?: CharacterRegistry, devOrigin?: string): void {
  instance.handle(APP_SCHEME, async (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 })
    const path = filePathForAppUrl(request.url, distRoot)
    if (!path) return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } })
    const pathname = new URL(request.url).pathname
    const corsHeaders: Record<string, string> = devOrigin && request.headers.get("origin") === devOrigin
      && (pathname.startsWith("/characters/") || pathname.startsWith("/character-packs/"))
      ? { "access-control-allow-origin": devOrigin, "vary": "Origin" } : {}
    const dataHeaders: Record<string, string> = { ...corsHeaders, "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox; frame-ancestors 'none'" }
    if (registry && pathname === "/characters/catalog.json") return new Response(request.method === "HEAD" ? null : JSON.stringify(registry.catalog()), { headers: { ...dataHeaders, "content-type": MIME[".json"], "cache-control": "no-store" } })
    if (pathname.startsWith("/character-packs/")) {
      if (["document", "iframe", "script", "style", "worker", "sharedworker", "serviceworker", "object", "embed"].includes(request.destination)) return new Response(null, { status: 403 })
      const asset = parsePackAssetUrl(request.url)
      const file = asset && registry ? await registry.resolveAsset(asset.id, asset.revision, asset.path) : null
      if (!file) return new Response(null, { status: 404, headers: { "cache-control": "no-store" } })
      try { return new Response(request.method === "HEAD" ? null : await readFile(file), { headers: { ...dataHeaders, "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "public, max-age=31536000, immutable" } }) }
      catch { return new Response(null, { status: 404, headers: { "cache-control": "no-store" } }) }
    }
    try {
      const body = await readFile(path)
      return new Response(request.method === "HEAD" ? null : body, {
        status: 200,
        headers: {
          ...corsHeaders,
          "content-type": MIME[extname(path).toLowerCase()] ?? "application/octet-stream",
          "x-content-type-options": "nosniff",
          "cache-control": path.endsWith(".html") ? "no-store" : "public, max-age=31536000, immutable",
          "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
        },
      })
    } catch {
      return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } })
    }
  })
}
