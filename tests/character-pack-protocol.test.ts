import { afterEach, describe, expect, it, vi } from "vitest"
import type { Protocol } from "electron"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
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
