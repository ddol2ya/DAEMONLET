import { constants, createReadStream } from "node:fs"
import { access, lstat, realpath } from "node:fs/promises"
import { createHash } from "node:crypto"
import { basename, delimiter, dirname, isAbsolute, join, win32 } from "node:path"
import { homedir } from "node:os"
import { findOfficialRuntime } from "./OfficialRuntimeRegistry.ts"
import { verifyInstalledOfficialRuntime } from "./OfficialRuntimeVerification.ts"

export function standardCodexExecutables(userHome = homedir(), platform = process.platform): string[] {
  if (platform === "win32") return [join(userHome, "AppData/Roaming/npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe")]
  return [
    ...(platform === "darwin" ? ["/opt/homebrew/bin/codex"] : []),
    "/usr/local/bin/codex", join(userHome, ".local/bin/codex"), join(userHome, ".npm-global/bin/codex"), join(userHome, "bin/codex"),
  ]
}


export function codexExecutableCandidates(selected?: string | null, env = process.env, home = homedir(), platform = process.platform) {
  if (selected) return [selected]
  const windows = platform === "win32", paths = windows ? win32 : { join, isAbsolute }
  const nativeNpm = "node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe"
  const standard = windows
    ? [...new Set([env.APPDATA, win32.join(home, "AppData", "Roaming")].filter((value): value is string => Boolean(value && win32.isAbsolute(value))))].map(dir => win32.join(dir, "npm", nativeNpm))
    : standardCodexExecutables(home, platform)
  // Preserve standard GUI/npm locations even when PATH expands beyond the scan budget.
  return [...new Set([
    ...standard,
    ...(env.PATH ?? env.Path ?? "").split(windows ? ";" : delimiter).filter(dir => paths.isAbsolute(dir)).slice(0, 32).flatMap(dir =>
      windows ? [paths.join(dir, "codex.exe"), paths.join(dir, nativeNpm)] : [paths.join(dir, "codex")]),
  ])].slice(0, 48)
}

/** Resolves only known package layouts. Shell/JS/PowerShell shims are never run.
 * The native payload must match reviewed bytes or an integrity-checked official
 * npm archive. Neither the wrapper nor an unverified native binary is executed. */
export async function resolveNativeCandidate(candidate: string, platform = process.platform, arch = process.arch) {
  if (!isAbsolute(candidate) || /[\0\r\n]/.test(candidate)) throw Error("CHAT_RUNTIME_UNSUPPORTED")
  const resolved = await realpath(candidate)
  const name = basename(resolved).toLowerCase()
  const target = platform === "darwin" && arch === "arm64" ? ["darwin-arm64", "aarch64-apple-darwin", "codex"]
    : platform === "win32" && arch === "x64" ? ["win32-x64", "x86_64-pc-windows-msvc", "codex.exe"] : null
  if (!target) throw Error("CHAT_RUNTIME_UNSUPPORTED")
  const [pkg, triple, binary] = target
  const suffix = `node_modules/@openai/codex-${pkg}/vendor/${triple}/bin/${binary}`
  if (name === "codex.js") return realpath(join(dirname(dirname(resolved)), suffix))
  if (platform === "win32" && ["codex.cmd", "codex.ps1"].includes(name)) return realpath(join(dirname(resolved), "node_modules/@openai/codex", suffix))
  return resolved
}


/** Shared by Hook setup, usage and side chat. Official bytes must be admitted
 * before any feature/protocol probe. Never run the npm wrapper. */
export async function inspectOfficialCodexExecutable(candidate: string, signal: AbortSignal) {
  signal.throwIfAborted()
  const executable = await resolveNativeCandidate(candidate)
  const before = await lstat(executable)
  if (!before.isFile() || before.size > 350 * 1024 * 1024 || process.platform !== "win32" && (![0, process.getuid?.()].includes(before.uid) || Boolean(before.mode & 0o022))) throw Error("CHAT_RUNTIME_UNSUPPORTED")
  await access(executable, constants.X_OK)
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(executable, { signal })) hash.update(chunk)
  const digest = hash.digest("hex")
  const runtime = findOfficialRuntime(digest, before.size) ?? await verifyInstalledOfficialRuntime(executable, digest, before.size, signal)
  const after = await lstat(executable)
  if (!runtime || ["dev", "ino", "size", "mtimeMs", "ctimeMs", "mode", "uid"].some(key => before[key as keyof typeof before] !== after[key as keyof typeof after])) throw Error("CHAT_RUNTIME_UNSUPPORTED")
  signal.throwIfAborted()
  return { executable, runtime }
}
