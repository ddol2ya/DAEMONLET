import { afterEach, describe, expect, it, vi } from "vitest"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { HuggingFacePackProvider, hfResolve, publicHfAddress, validateHfUrl, type HfResponse } from "../electron/main/pack-updates/HuggingFacePackProvider"
import type { PackUpdateFeed } from "../electron/shared/pack-update-contract"
const source = { schemaVersion: 1, provider: "huggingface", repoType: "dataset", repoId: "fixture/characters", manifestPath: "updates/style-a/stable.json" } as const
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))) })
const reply = (status: number, bytes = Buffer.alloc(0), headers: Record<string, string> = {}): HfResponse => ({ status, headers, close: vi.fn(), body: (async function* () { yield bytes.subarray(0, 2); yield bytes.subarray(2) })() })
describe("anonymous HF provider", () => {
  it.each(["http://huggingface.co/a", "https://huggingface.co.evil.test/a", "https://127.0.0.1/a", "https://169.254.169.254/a", "https://user:pass@huggingface.co/a", "https://huggingface.co:444/a", "https://bucket.amazonaws.com/a", "file:///x", "https://[::1]/x"])("rejects redirect %s", url => expect(() => validateHfUrl(url)).toThrow())
  it("rejects private DNS results including mapped addresses", () => {
    for (const [a, f] of [[[10, 1, 2, 3].join("."), 4], ["127.0.0.1", 4], ["169.254.169.254", 4], ["fc00::1", 6], ["::ffff:127.0.0.1", 6], ["::1", 6]] as const) expect(publicHfAddress(a, f)).toBe(false)
    expect(publicHfAddress("1.1.1.1", 4)).toBe(true)
  })
  it("pins artifact commits, follows only approved delivery redirects, and sends no credentials", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hf-provider-")); roots.push(dir)
    const bytes = Buffer.concat([Buffer.from("504b0304", "hex"), Buffer.alloc(64, 7)]), sha256 = createHash("sha256").update(bytes).digest("hex")
    const open = vi.fn().mockResolvedValueOnce(reply(302, undefined, { location: "https://cas-bridge.xethub.hf.co/file?Signature=private" })).mockResolvedValueOnce(reply(200, bytes, { "content-length": String(bytes.length) }))
    const provider = new HuggingFacePackProvider(open)
    const feed = { artifact: { path: "packs/style-a/1.0.1.petchar", revision: "c".repeat(40), bytes: bytes.length, sha256 } } as PackUpdateFeed
    const target = join(dir, "download.petchar")
    await provider.download(source, feed, target, new AbortController().signal, vi.fn())
    expect(await readFile(target)).toEqual(bytes)
    expect(open.mock.calls[0][0].href).toContain(`/resolve/${"c".repeat(40)}/`)
    expect(open.mock.calls.every(c => Object.keys(c[2]).length === 0)).toBe(true)
    expect(await readdir(dir)).toEqual(["download.petchar"])
    expect(hfResolve(source)).toContain("/resolve/main/updates/style-a/stable.json")
  })
  it("cleans partial bytes after mismatch and cancellation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hf-provider-")); roots.push(dir)
    const bytes = Buffer.concat([Buffer.from("504b0304", "hex"), Buffer.alloc(64)])
    const feed = { artifact: { path: "packs/a.petchar", revision: "a".repeat(40), bytes: bytes.length, sha256: "0".repeat(64) } } as PackUpdateFeed
    for (const mode of ["hash", "size", "cancel", "html"]) {
      const controller = new AbortController(), open = vi.fn(async () => reply(200, bytes, mode === "size" ? { "content-length": "9999" } : mode === "html" ? { "content-type": "text/html" } : {}))
      await expect(new HuggingFacePackProvider(open).download(source, feed, join(dir, "pack.petchar"), controller.signal, () => { if (mode === "cancel") controller.abort() })).rejects.toThrow()
      expect(await readdir(dir)).toEqual([])
    }
  })
  it("handles 304, 403, 404, throttling and redirect loops without consuming unbounded bodies", async () => {
    for (const status of [403, 404, 429]) {
      const provider = new HuggingFacePackProvider(vi.fn(async () => reply(status, undefined, { "retry-after": "120" })))
      await expect(provider.feed(source, new AbortController().signal)).rejects.toThrow(status === 429 ? "PACK_UPDATE_RATE" : `PACK_UPDATE_HTTP_${status}`)
    }
    expect(await new HuggingFacePackProvider(vi.fn(async () => reply(304))).feed(source, new AbortController().signal)).toEqual({ notModified: true })
    const loop = vi.fn(async () => reply(302, undefined, { location: "https://huggingface.co/loop" }))
    await expect(new HuggingFacePackProvider(loop).feed(source, new AbortController().signal)).rejects.toThrow("PACK_UPDATE_REDIRECT")
    expect(loop).toHaveBeenCalledTimes(6)
    const evil = vi.fn(async () => reply(302, undefined, { location: "https://localhost/secret" }))
    await expect(new HuggingFacePackProvider(evil).feed(source, new AbortController().signal)).rejects.toThrow("PACK_UPDATE_REDIRECT")
    expect(evil).toHaveBeenCalledOnce()
  })
})
