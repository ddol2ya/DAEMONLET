import { lstat, readFile, realpath } from "node:fs/promises"
import { dirname, join, relative, sep } from "node:path"
import { gte, valid } from "semver"
import { hashOfficialRuntimeArchive } from "./OfficialRuntimeArchive"

export const MINIMUM_CODEX_VERSION = "0.154.0"
export const RUNTIME_VERIFICATION_TIMEOUT_MS = 120_000
const invalid = () => Error("CHAT_RUNTIME_UNSUPPORTED")
type VerifiedRuntime = { kind: "official"; version: string; executableSha256: string; executableBytes: number; source: string; packageIntegrity: string }
// Process-local only: no editable disk cache can grant executable trust.
const verified = new Map<string, VerifiedRuntime>()

export function compatiblePackageVersion(value: unknown, platform: string, arch: string): string | null {
  if (typeof value !== "string" || value.length > 100) return null
  const suffix = `-${platform}-${arch}`
  if (!value.endsWith(suffix)) return null
  const version = value.slice(0, -suffix.length)
  return valid(version) === version && gte(version, MINIMUM_CODEX_VERSION) ? version : null
}

async function* responseBytes(response: Response, limit: number) {
  const length = response.headers.get("content-length")
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) { await response.body?.cancel(); throw invalid() }
  if (!response.body) throw invalid()
  const reader = response.body.getReader()
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > limit) throw invalid()
      yield value
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

async function get(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal, redirect: "error", credentials: "omit", headers: { Accept: "application/json, application/octet-stream" } })
  if (!response.ok) { await response.body?.cancel(); throw invalid() }
  return response
}

/** Unregistered versions are admitted only after matching the official npm
 * archive byte-for-byte. Local package metadata is an untrusted version hint;
 * it never authorizes execution. No installer, shim or unknown CLI is run. */
export async function verifyInstalledOfficialRuntime(executable: string, digest: string, bytes: number, signal: AbortSignal, platform = process.platform, arch = process.arch): Promise<VerifiedRuntime | null> {
  const triple = platform === "darwin" && arch === "arm64" ? "aarch64-apple-darwin"
    : platform === "win32" && arch === "x64" ? "x86_64-pc-windows-msvc" : null
  if (!triple) return null
  const binary = platform === "win32" ? "codex.exe" : "codex"
  // npm native packages have one fixed layout, including when installed through
  // a package-manager alias. Standalone registered hashes remain supported.
  const root = dirname(dirname(dirname(dirname(executable))))
  const nativePath = `vendor/${triple}/bin/${binary}`
  if (relative(root, executable).split(sep).join("/") !== nativePath) return null
  const manifestPath = join(root, "package.json"), info = await lstat(manifestPath)
  if (!info.isFile() || info.size > 64 * 1024) return null
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
  const version = compatiblePackageVersion(manifest.version, platform, arch)
  if (manifest.name !== "@openai/codex" || !version || await realpath(executable) !== executable) return null
  const packageVersion = `${version}-${platform}-${arch}`
  const source = `https://registry.npmjs.org/@openai/codex/${packageVersion}`
  let runtime = verified.get(source)
  if (!runtime) {
    const chunks: Uint8Array[] = []
    for await (const chunk of responseBytes(await get(source, signal), 256 * 1024)) chunks.push(chunk)
    const metadata = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    const tarball = `https://registry.npmjs.org/@openai/codex/-/codex-${packageVersion}.tgz`
    const integrity = metadata.dist?.integrity
    if (metadata.name !== "@openai/codex" || metadata.version !== packageVersion || metadata.dist?.tarball !== tarball || typeof integrity !== "string" || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)) throw invalid()
    const payload = await hashOfficialRuntimeArchive(responseBytes(await get(tarball, signal), 512 * 1024 * 1024), `package/${nativePath}`, integrity, signal)
    runtime = { kind: "official", version, source, packageIntegrity: integrity, ...payload }
    if (verified.size >= 16) verified.delete(verified.keys().next().value!)
    verified.set(source, runtime)
  }
  signal.throwIfAborted()
  return runtime.executableSha256 === digest && runtime.executableBytes === bytes ? runtime : null
}
