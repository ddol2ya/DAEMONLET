import { constants, createReadStream } from "node:fs"
import { access, lstat, realpath } from "node:fs/promises"
import { createHash } from "node:crypto"
import { basename, delimiter, dirname, isAbsolute, join, win32 } from "node:path"
import { homedir } from "node:os"
import { standardCodexExecutables } from "../../../adapter/codex/doctor/HookSetupDoctor"
import { OFFICIAL_RUNTIME_REGISTRY, findOfficialRuntime } from "./OfficialRuntimeRegistry"
import { RUNTIME_VERIFICATION_TIMEOUT_MS, verifyInstalledOfficialRuntime } from "./OfficialRuntimeVerification"

export function sideChatCandidates(selected?: string | null, env = process.env, home = homedir(), platform = process.platform) {
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

export async function inspectSideChatRuntime(selected?: string | null, signal?: AbortSignal) {
  if (!OFFICIAL_RUNTIME_REGISTRY.some(item => item.platform === process.platform && item.arch === process.arch)) throw Error("CHAT_PLATFORM_UNVERIFIED")
  const deadline = AbortSignal.timeout(RUNTIME_VERIFICATION_TIMEOUT_MS)
  const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline
  let found = false
  const seen = new Set<string>()
  for (const candidate of sideChatCandidates(selected)) {
    bounded.throwIfAborted()
    try {
      const executable = await resolveNativeCandidate(candidate)
      if (seen.has(executable)) continue
      seen.add(executable)
      const before = await lstat(executable); found = true
      if (!before.isFile() || before.size > 350 * 1024 * 1024 || process.platform !== "win32" && (![0, process.getuid?.()].includes(before.uid) || Boolean(before.mode & 0o022))) continue
      await access(executable, constants.X_OK)
      const hash = createHash("sha256")
      for await (const chunk of createReadStream(executable, { signal: bounded })) hash.update(chunk)
      const after = await lstat(executable)
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) continue
      const digest = hash.digest("hex")
      const runtime = findOfficialRuntime(digest, before.size) ?? await verifyInstalledOfficialRuntime(executable, digest, before.size, bounded)
      const checked = await lstat(executable)
      if (before.dev !== checked.dev || before.ino !== checked.ino || before.size !== checked.size || before.mtimeMs !== checked.mtimeMs || before.ctimeMs !== checked.ctimeMs || before.mode !== checked.mode || before.uid !== checked.uid) continue
      if (runtime) return { executable, runtime }
    } catch { /* Inspect the next bounded candidate, never execute an unknown file. */ }
  }
  bounded.throwIfAborted()
  throw Error(found ? "CHAT_RUNTIME_UNSUPPORTED" : "CHAT_RUNTIME_MISSING")
}
