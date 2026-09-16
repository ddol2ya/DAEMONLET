import { constants, createReadStream } from "node:fs"
import { access, lstat, realpath } from "node:fs/promises"
import { createHash } from "node:crypto"
import { basename, delimiter, dirname, isAbsolute, join } from "node:path"
import { homedir } from "node:os"
import { standardCodexExecutables } from "../../../adapter/codex/doctor/HookSetupDoctor"
import { OFFICIAL_RUNTIME_REGISTRY } from "./OfficialRuntimeRegistry"

export function sideChatCandidates(selected?: string | null, env = process.env, home = homedir(), platform = process.platform) {
  if (selected) return [selected]
  const windows = platform === "win32"
  return [...new Set([
    ...(env.PATH ?? "").split(windows ? ";" : delimiter).filter(isAbsolute).slice(0, 32).flatMap(dir =>
      windows ? [join(dir, "codex.exe"), join(dir, "node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe")] : [join(dir, "codex")]),
    ...standardCodexExecutables(home, platform),
  ])].slice(0, 48)
}

/** Resolves only known package layouts. Shell/JS/PowerShell shims are never run.
 * The native payload must independently match a reviewed hash. */
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

export async function inspectSideChatRuntime(selected?: string | null) {
  if (!OFFICIAL_RUNTIME_REGISTRY.some(item => item.platform === process.platform && item.arch === process.arch)) throw Error("CHAT_PLATFORM_UNVERIFIED")
  let found = false
  const seen = new Set<string>()
  for (const candidate of sideChatCandidates(selected)) {
    try {
      const executable = await resolveNativeCandidate(candidate)
      if (seen.has(executable)) continue
      seen.add(executable)
      const before = await lstat(executable); found = true
      if (!before.isFile() || before.size > 350 * 1024 * 1024 || ![0, process.getuid?.()].includes(before.uid) || before.mode & 0o022) continue
      await access(executable, constants.X_OK)
      const hash = createHash("sha256")
      for await (const chunk of createReadStream(executable)) hash.update(chunk)
      const after = await lstat(executable)
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) continue
      const digest = hash.digest("hex")
      const runtime = OFFICIAL_RUNTIME_REGISTRY.find(item => item.executableSha256 === digest && item.executableBytes === before.size)
      if (runtime) return { executable, runtime }
    } catch { /* Inspect the next bounded candidate, never execute an unknown file. */ }
  }
  throw Error(found ? "CHAT_RUNTIME_UNSUPPORTED" : "CHAT_RUNTIME_MISSING")
}
