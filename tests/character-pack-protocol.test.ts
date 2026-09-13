import { afterEach, describe, expect, it, vi } from "vitest"
import type { Protocol } from "electron"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { installAppProtocol } from "../electron/main/AppProtocol"
import type { CharacterRegistry } from "../electron/main/CharacterRegistry"

vi.mock("electron", () => ({ protocol: {} }))
const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))) })
describe("pack protocol serving", () => {
  it("serves a no-store dynamic catalog and immutable inventory data with safe MIME", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pack-protocol-")); dirs.push(dir); const file = join(dir, "character.json"); await writeFile(file, "{}")
    let handler!: (request: Request) => Promise<Response>
    const protocol = { handle: (_scheme: string, fn: typeof handler) => { handler = fn } } as unknown as Protocol
    const resolve = vi.fn(async (id: string, _rev: string, path: string) => id === "fresh" && path === "character.json" ? file : null)
    const registry = { catalog: () => ({ schemaVersion: 1, generation: 7, characters: [] }), resolveAsset: resolve } as unknown as CharacterRegistry
    installAppProtocol(dir, protocol, registry)
    const catalog = await handler(new Request("pet://app/characters/catalog.json"))
    expect(catalog.headers.get("cache-control")).toBe("no-store"); expect(await catalog.json()).toMatchObject({ generation: 7 })
    const url = `pet://app/character-packs/fresh/${"a".repeat(64)}/character.json`
    const response = await handler(new Request(url))
    expect(await response.text()).toBe("{}"); expect(response.headers.get("content-type")).toContain("application/json")
    expect(response.headers.get("x-content-type-options")).toBe("nosniff"); expect(response.headers.get("cache-control")).toContain("immutable")
    expect((await handler(new Request(url, { method: "HEAD" }))).body).toBeNull()
    expect((await handler(new Request(url, { method: "POST" }))).status).toBe(405)
    expect((await handler({ url, method: "GET", headers: new Headers(), destination: "script" } as Request)).status).toBe(403)
    expect((await handler({ url, method: "GET", headers: new Headers(), destination: "document" } as Request)).status).toBe(403)
    for (const path of ["registry.json", "../desktop-settings.json", "%252e%252e/secret"]) expect((await handler(new Request(url.replace("character.json", path)))).status).toBe(404)
    expect((await handler(new Request(url.replace("/fresh/", "/other/")))).status).toBe(404)
  })
})

// Electron 43 rejects cross-scheme fetch unless CORS is registered and the
// response permits the exact Vite origin, including every built-in asset.
it("permits development character fetches only from the configured origin", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dev-protocol-")); dirs.push(dir)
  await mkdir(join(dir, "characters")); await writeFile(join(dir, "characters", "model.psd"), "fixture")
  let handler!: (request: Request) => Promise<Response>
  const protocol = {handle: (_scheme: string, fn: typeof handler) => {handler = fn}} as unknown as Protocol
  const registry = {catalog: () => ({characters: []})} as unknown as CharacterRegistry
  const origin = "http://127.0.0.1:4173"
  installAppProtocol(dir, protocol, registry, origin)
  for (const path of ["catalog.json", "model.psd"]) {
    const allowed = await handler(new Request(`pet://app/characters/${path}`, {headers: {origin}}))
    expect(allowed.status).toBe(200); expect(allowed.headers.get("access-control-allow-origin")).toBe(origin)
    for (const other of ["http://127.0.0.1:4174", "https://example.invalid", "null"]) {
      const denied = await handler(new Request(`pet://app/characters/${path}`, {headers: {origin: other}}))
      expect(denied.headers.has("access-control-allow-origin")).toBe(false)
    }
  }
  installAppProtocol(dir, protocol, registry)
  expect((await handler(new Request("pet://app/characters/model.psd", {headers: {origin}}))).headers.has("access-control-allow-origin")).toBe(false)
})
