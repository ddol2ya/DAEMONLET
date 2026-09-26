import { afterEach, describe, expect, it, vi } from "vitest"
import { createHash } from "node:crypto"
import { gzipSync } from "node:zlib"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { hashOfficialRuntimeArchive } from "../electron/main/side-chat/OfficialRuntimeArchive"
import { compatiblePackageVersion, verifyInstalledOfficialRuntime } from "../electron/main/side-chat/OfficialRuntimeVerification"

const roots: string[] = []
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const sha = (bytes: Buffer, algorithm = "sha256", encoding: "hex" | "base64" = "hex") => createHash(algorithm).update(bytes).digest(encoding)
const path = "package/vendor/aarch64-apple-darwin/bin/codex"
function entry(name: string, value: Buffer, type = "0") {
  const header = Buffer.alloc(512)
  header.write(name); header.write("0000755\0", 100); header.write(value.length.toString(8).padStart(11, "0") + "\0", 124)
  header.fill(32, 148, 156); header.write(type, 156); header.write("ustar\0", 257)
  header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ", 148)
  return Buffer.concat([header, value, Buffer.alloc((512 - value.length % 512) % 512)])
}
function archive(entries: Buffer[], ending = true) { return gzipSync(Buffer.concat([...entries, ...(ending ? [Buffer.alloc(1024)] : [])])) }
const integrity = (value: Buffer) => `sha512-${sha(value, "sha512", "base64")}`
async function* chunks(value: Buffer) { for (let i = 0; i < value.length; i += 17) yield value.subarray(i, i + 17) }
const inspect = (value: Buffer, expected = integrity(value)) => hashOfficialRuntimeArchive(chunks(value), path, expected, new AbortController().signal)

describe("official npm archive verification without extraction", () => {
  it("hashes only the target across fragmented gzip/tar boundaries", async () => {
    const native = Buffer.alloc(1500, 42), packed = archive([entry("package/README.md", Buffer.from("notice")), entry(path, native)])
    expect(await inspect(packed)).toEqual({ executableBytes: native.length, executableSha256: sha(native) })
    await expect(inspect(packed, integrity(Buffer.from("different")))).rejects.toThrow("CHAT_RUNTIME_UNSUPPORTED")
  })
  it.each(["duplicate", "symlink", "truncated", "wrong-platform", "bad-header"])("rejects %s even with matching archive integrity", async kind => {
    const one = entry(path, Buffer.from("native"))
    const entries = kind === "duplicate" ? [one, one] : kind === "symlink" ? [entry(path, Buffer.from("target"), "2")]
      : kind === "wrong-platform" ? [entry("package/vendor/x86_64-pc-windows-msvc/bin/codex.exe", Buffer.from("native"))] : [one]
    if (kind === "bad-header") entries[0][0] ^= 1
    await expect(inspect(archive(entries, kind !== "truncated"))).rejects.toThrow("CHAT_RUNTIME_UNSUPPORTED")
  })
  it("stops a cancelled stream without accepting a partial digest", async () => {
    const controller = new AbortController(); controller.abort()
    await expect(hashOfficialRuntimeArchive(chunks(archive([entry(path, Buffer.from("native"))])), path, "unused", controller.signal)).rejects.toThrow()
  })
})

describe("minimum version and independent official byte matching", () => {
  it.each(["0.154.0", "0.154.1", "0.155.0", "1.0.0", "12.0.0"])("accepts %s without an upper-version allowlist", version => {
    expect(compatiblePackageVersion(`${version}-darwin-arm64`, "darwin", "arm64")).toBe(version)
    expect(compatiblePackageVersion(`${version}-win32-x64`, "win32", "x64")).toBe(version)
  })
  it.each(["0.153.9-darwin-arm64", "0.154.0-alpha-darwin-arm64", "0.154.0-win32-x64", "01.154.0-darwin-arm64", "../../other", null])("rejects an old, malformed or wrong-platform hint: %s", version => {
    expect(compatiblePackageVersion(version, "darwin", "arm64")).toBeNull()
  })
  async function fixture(version: string) {
    const root = await realpath(await mkdtemp(join(tmpdir(), "official-runtime-test-"))); roots.push(root)
    const executable = join(root, path.slice("package/".length)), native = Buffer.from("fixture bytes; never execute this file")
    await mkdir(join(executable, ".."), { recursive: true }); await writeFile(executable, native)
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "@openai/codex", version: `${version}-darwin-arm64` }))
    const packed = archive([entry(path, native)]), tarball = `https://registry.npmjs.org/@openai/codex/-/codex-${version}-darwin-arm64.tgz`
    const metadata = { name: "@openai/codex", version: `${version}-darwin-arm64`, dist: { tarball, integrity: integrity(packed) } }
    const fetcher = vi.fn(async (url: string) => url === tarball ? new Response(new Uint8Array(packed)) : Response.json(metadata))
    vi.stubGlobal("fetch", fetcher)
    const verify = (digest = sha(native)) => verifyInstalledOfficialRuntime(executable, digest, native.length, new AbortController().signal, "darwin", "arm64")
    return { verify, fetcher, metadata, native, packed }
  }
  it("admits a new version only after official integrity and native hash/size agree, then reuses official evidence", async () => {
    const f = await fixture("0.155.10")
    expect(await f.verify()).toMatchObject({ kind: "official", version: "0.155.10", executableSha256: sha(f.native) })
    expect(f.fetcher).toHaveBeenCalledTimes(2)
    expect(f.fetcher.mock.calls.every(call => call[0].startsWith("https://registry.npmjs.org/@openai/codex/"))).toBe(true)
    expect(await f.verify("0".repeat(64))).toBeNull()
    expect(await f.verify()).not.toBeNull(); expect(f.fetcher).toHaveBeenCalledTimes(2)
  })
  it.each(["url", "version", "integrity"])("rejects mismatched official metadata %s before any executable admission", async kind => {
    const f = await fixture(`0.156.${["url", "version", "integrity"].indexOf(kind)}`)
    if (kind === "url") f.metadata.dist.tarball = "https://untrusted.invalid/payload.tgz"
    if (kind === "version") f.metadata.version = "0.153.0-darwin-arm64"
    if (kind === "integrity") f.metadata.dist.integrity = integrity(Buffer.from("not the archive"))
    await expect(f.verify()).rejects.toThrow("CHAT_RUNTIME_UNSUPPORTED")
    expect(f.fetcher).toHaveBeenCalledTimes(kind === "integrity" ? 2 : 1)
  })
  it("does not query the network for versions below the floor", async () => {
    const f = await fixture("0.153.9")
    expect(await f.verify()).toBeNull(); expect(f.fetcher).not.toHaveBeenCalled()
  })
  it("fails closed when npm is unavailable and does not cache that failure", async () => {
    const f = await fixture("0.157.0")
    f.fetcher.mockResolvedValueOnce(new Response(null, { status: 503 }))
    await expect(f.verify()).rejects.toThrow("CHAT_RUNTIME_UNSUPPORTED")
    expect(await f.verify()).toMatchObject({ version: "0.157.0" })
  })
})
