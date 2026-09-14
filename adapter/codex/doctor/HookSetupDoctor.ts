import { constants } from "node:fs"
import { spawn } from "node:child_process"
import { access, lstat, realpath, open } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { basename, delimiter, dirname, isAbsolute, join } from "node:path"
import { parse as parseToml } from "smol-toml"
import { containsHookMarker, HOOK_SYSTEM_PATH, hashFile, hashText } from "../hooks/HookLaunchSpec.ts"
import { allEventSupport, type EventSupport } from "../hooks/HookInstallPlan.ts"
import { isObject } from "../hooks/HookJson.ts"
import { canonicalCodexHome, readSetupConfig } from "../hooks/HookInstallTransaction.ts"
import { VERIFIED_HOOK_CONTRACTS, hookContractFor, type HookSupportContract } from "./HookSupportContract.ts"

export type CodexSelection = { executablePath: string | null; codexHome: string | null }
export type HookSetupDiscovery = {
  checkedAt: number
  home: { path: string; source: "selected" | "environment" | "default" }
  executable: { path: string | null; source: "selected" | "environment" | "path" | "installation" | "not-found"; version: string | null; probeStatus: "verified" | "selection-required" | "missing" | "failed" | "version-mismatch"; fingerprint: string | null }
  capability: { contractId: string | null; source: "installed-artifact-and-fixtures" | "test-fixture" | "unknown"; surface: "cli" | "desktop" | "synthetic" | "unknown"; events: EventSupport }
  feature: "enabled" | "disabled" | "unknown"
  policy: "blocked" | "not-blocked-in-checked-file" | "unknown"
  inlineOwnedConflict: boolean
  configFingerprint: string
  warnings: string[]
  manualFeatureInstruction: string | null
  inspectedScope: string[]
  uninspectedScope: string[]
}

export function parseHookFeatureOutput(output: string): "enabled" | "disabled" | "unknown" {
  const lines = output.split(/\r?\n/).map((line) => /^(hooks|codex_hooks)\s+\S+(?:\s+\S+)*\s+(true|false)\s*$/.exec(line.trim())).filter((line) => line !== null)
  const canonical = lines.find((line) => line[1] === "hooks") ?? lines.find((line) => line[1] === "codex_hooks")
  return canonical ? canonical[2] === "true" ? "enabled" : "disabled" : "unknown"
}

function inspectConfig(config: string | null, policy: string | null): { feature: "enabled" | "disabled" | "unknown"; inlineOwnedConflict: boolean; policyBlocked: boolean } {
  const parsed = config === null ? {} : parseToml(config)
  const requirements = policy === null ? {} : parseToml(policy)
  const features = isObject(parsed.features) ? parsed.features : {}
  const requiredFeatures = isObject(requirements.features) ? requirements.features : {}
  const flag = features.hooks ?? features.codex_hooks
  return {
    feature: typeof flag === "boolean" ? flag ? "enabled" : "disabled" : "unknown",
    // Conservatively report suspected inline ownership, never migrate or
    // reinterpret inline TOML. Unknown metadata containing the marker is a
    // reason for review, not authority to delete anything.
    inlineOwnedConflict: isObject(parsed.hooks) && containsHookMarker(parsed.hooks),
    policyBlocked: requirements.allow_managed_hooks_only === true || requiredFeatures.hooks === false || requiredFeatures.codex_hooks === false,
  }
}

async function checkedExecutable(path: string): Promise<string | null> {
  try {
    if (!isAbsolute(path) || /[\0\r\n]/.test(path)) return null
    const canonical = await realpath(path)
    const stat = await lstat(canonical)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 350 * 1024 * 1024 || (process.platform !== "win32" && (![0, process.getuid?.() ?? 0].includes(stat.uid) || (stat.mode & 0o022) !== 0))) return null
    if (process.platform === "win32") {
      const file = await open(canonical, "r")
      try { const header = Buffer.alloc(2); if ((await file.read(header, 0, 2, 0)).bytesRead !== 2 || header.toString("ascii") !== "MZ") return null }
      finally { await file.close() }
    }
    await access(canonical, constants.X_OK)
    return canonical
  } catch { return null }
}

// The known npm wrapper is resolved to its native payload without running the
// wrapper or searching the installation recursively. This does not make Codex's
// own npm distribution Node-independent; it only avoids running an arbitrary
// PATH script during discovery.
const KNOWN_NPM_WRAPPERS = new Set([
  "134063e133f0b4244fa3b251acf973d4fe4b4aeeacbdc135211bf480f59f1477", // 0.147.0
  "61b0194f3bb6534439c8d26a3ed57d0805f84b884588b761795323eeb92fcf70", // 0.153.4
])
async function unwrapKnownNpmExecutable(path: string): Promise<string> {
  if (process.platform !== "darwin" || process.arch !== "arm64" || basename(path) !== "codex.js") return path
  if (!KNOWN_NPM_WRAPPERS.has(await hashFile(path))) return path
  const native = join(dirname(dirname(path)), "node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex")
  return await checkedExecutable(native) ?? path
}

export type HookSetupDoctorOptions = {
  environment?: NodeJS.ProcessEnv
  defaultHome?: string
  policyPath?: string | null
  contracts?: readonly HookSupportContract[]
  now?: () => number
  probeTimeoutMs?: number
  additionalExecutables?: () => Promise<string[]>
}

/** Finder-launched apps do not inherit the user's shell PATH. No shell or
 * recursive filesystem search is needed for these standard installation paths. */
export function standardCodexExecutables(userHome = homedir(), platform = process.platform): string[] {
  if (platform === "win32") return [join(userHome, "AppData/Roaming/npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe")]
  return [
    ...(platform === "darwin" ? ["/opt/homebrew/bin/codex"] : []),
    "/usr/local/bin/codex", join(userHome, ".local/bin/codex"), join(userHome, ".npm-global/bin/codex"), join(userHome, "bin/codex"),
  ]
}

export class HookSetupDoctor {
  private readonly options: HookSetupDoctorOptions
  private readonly environment: NodeJS.ProcessEnv
  private readonly now: () => number
  private cache: { key: string; revision: string; expiresAt: number; value: HookSetupDiscovery } | null = null
  private pending: { key: string; promise: Promise<HookSetupDiscovery> } | null = null
  private readonly children = new Set<ReturnType<typeof spawn>>()
  private generation = 0
  private closed = false

  constructor(options: HookSetupDoctorOptions = {}) {
    this.options = options
    this.environment = options.environment ?? process.env
    this.now = options.now ?? Date.now
  }

  invalidate(): void {
    this.generation++
    this.cache = null
    this.pending = null
    for (const child of this.children) this.kill(child)
  }
  dispose(): void { this.closed = true; this.invalidate() }

  async inspect(selection: CodexSelection, refresh = false): Promise<HookSetupDiscovery> {
    if (this.closed) throw new Error("DOCTOR_CLOSED")
    const key = JSON.stringify(selection)
    const cached = this.cache
    if (!refresh && cached?.key === key && cached.expiresAt > this.now() && cached.revision === await this.revision(cached.value, selection)) return structuredClone(cached.value)
    if (!refresh && this.pending?.key === key) return this.pending.promise.then((value) => structuredClone(value))
    this.invalidate()
    const generation = this.generation
    const promise = this.run(selection, generation).then(async (value) => {
      if (this.closed || this.generation !== generation) throw new Error("PROBE_CANCELLED")
      const revision = await this.revision(value, selection)
      if (this.closed || this.generation !== generation) throw new Error("PROBE_CANCELLED")
      this.cache = { key, revision, expiresAt: this.now() + 30_000, value }
      return value
    }).finally(() => { if (this.generation === generation) this.pending = null })
    this.pending = { key, promise }
    return promise.then((value) => structuredClone(value))
  }

  private async revision(value: HookSetupDiscovery, selection: CodexSelection): Promise<string> {
    const paths = [join(value.home.path, "config.toml"), this.options.policyPath === undefined ? "/etc/codex/requirements.toml" : this.options.policyPath, value.executable.path, selection.executablePath ?? this.environment.CODEX_PATH]
    const metadata = await Promise.all(paths.map(async (path) => {
      if (!path) return null
      try { const canonical = await realpath(path); const stat = await lstat(canonical); return [canonical, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode, stat.uid] }
      catch { return "missing-or-unavailable" }
    }))
    return hashText(JSON.stringify(metadata))
  }

  private kill(child: ReturnType<typeof spawn>): void {
    try { if (child.pid) process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL") } catch { /* already reaped */ }
  }

  private probe(path: string, args: ["--version"] | ["features", "list"], codexHome: string, generation: number): Promise<string> {
    if (this.closed || this.generation !== generation) return Promise.reject(new Error("PROBE_CANCELLED"))
    return new Promise((done, reject) => {
      let output = "", bytes = 0, rejected = false, settled = false
      const child = spawn(path, args, {
        cwd: tmpdir(), shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: { ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } : {}), PATH: this.environment.PATH ?? HOOK_SYSTEM_PATH, CODEX_HOME: codexHome },
      })
      const timeout = setTimeout(() => { rejected = true; this.kill(child) }, this.options.probeTimeoutMs ?? 2000)
      const finish = (code: number | null) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        this.children.delete(child)
        if (code !== 0 || rejected || this.closed || generation !== this.generation) reject(new Error("CODEX_PROBE_FAILED"))
        else done(output.trim())
      }
      const consume = (chunk: Buffer, stdout: boolean) => {
        bytes += chunk.length
        if (bytes > 64 * 1024) { rejected = true; this.kill(child); return }
        if (stdout) output += chunk.toString()
      }
      child.stdout.on("data", (chunk: Buffer) => consume(chunk, true))
      child.stderr.on("data", (chunk: Buffer) => consume(chunk, false))
      child.once("error", () => finish(null))
      child.once("close", finish)
      this.children.add(child)
    })
  }

  private async run(selection: CodexSelection, generation: number): Promise<HookSetupDiscovery> {
    const requestedHome = selection.codexHome ?? this.environment.CODEX_HOME ?? this.options.defaultHome ?? join(homedir(), ".codex")
    const home = { path: await canonicalCodexHome(requestedHome), source: selection.codexHome ? "selected" as const : this.environment.CODEX_HOME ? "environment" as const : "default" as const }
    const value: HookSetupDiscovery = {
      checkedAt: this.now(), home,
      executable: { path: null, source: "not-found", version: null, probeStatus: "missing", fingerprint: null },
      capability: { contractId: null, source: "unknown", surface: "unknown", events: allEventSupport("unknown") },
      feature: "unknown", policy: "unknown", inlineOwnedConflict: false, configFingerprint: "", warnings: [], manualFeatureInstruction: null,
      inspectedScope: ["selected-user-hooks.json", "selected-user-config.toml"],
      uninspectedScope: ["project-hooks", "plugin-hooks", "other-users", "MDM-and-cloud-policy", "hook-trust-store"],
    }
    let config: string | null = null, policy: string | null = null
    try {
      config = await readSetupConfig(join(home.path, "config.toml"))
      const policyPath = this.options.policyPath === undefined ? "/etc/codex/requirements.toml" : this.options.policyPath
      if (policyPath) { policy = await readSetupConfig(policyPath, true); value.inspectedScope.push("known-system-requirements.toml") }
      const local = inspectConfig(config, policy)
      value.feature = local.feature
      value.inlineOwnedConflict = local.inlineOwnedConflict
      value.policy = local.policyBlocked ? "blocked" : policy === null ? "unknown" : "not-blocked-in-checked-file"
    } catch { value.warnings.push("CONFIG_UNREADABLE_OR_INVALID") }
    value.configFingerprint = hashText(JSON.stringify({ home: home.path, config, policy, warnings: value.warnings }))
    const explicit = selection.executablePath ?? this.environment.CODEX_PATH
    const pathCandidates = [...new Set((this.environment.PATH ?? "").split(delimiter).filter((path) => isAbsolute(path)).map((path) => join(path, "codex")))].slice(0, 32)
    const installations = explicit ? [] : [
      // An injected environment is an isolated discovery scope (tests/embedded
      // callers); do not silently inspect the host user's installations there.
      ...(this.options.environment ? [] : standardCodexExecutables()),
      ...await this.options.additionalExecutables?.().catch(() => []) ?? [],
    ].slice(0, 16)
    const candidates = explicit ? [explicit] : [...new Set([...pathCandidates, ...installations])]
    const contracts = this.options.contracts ?? VERIFIED_HOOK_CONTRACTS
    const checked = new Set<string>()
    for (const candidate of candidates) {
      const path = await checkedExecutable(candidate)
      if (!path) continue
      const executable = await unwrapKnownNpmExecutable(path)
      if (checked.has(executable)) continue
      checked.add(executable)
      const fingerprint = await hashFile(executable)
      const known = contracts.some(item => item.artifactSha256 === fingerprint)
      if (!value.executable.path || known) {
        value.executable.path = executable
        value.executable.fingerprint = fingerprint
        value.executable.source = selection.executablePath ? "selected" : this.environment.CODEX_PATH ? "environment" : pathCandidates.includes(candidate) ? "path" : "installation"
      }
      // A stale/unrecognized PATH wrapper must not conceal an already verified
      // installed payload. Unknown candidates are still never auto-executed.
      if (explicit || known) break
    }
    if (!value.executable.path) { value.warnings.push(explicit ? "SELECTED_CODEX_UNAVAILABLE" : "CLI_NOT_FOUND_DESKTOP_MAY_STILL_WORK"); return value }
    const artifactKnown = contracts.some((item) => item.artifactSha256 === value.executable.fingerprint)
    if (!artifactKnown && !selection.executablePath) {
      value.executable.probeStatus = "selection-required"
      value.warnings.push("SELECT_EXECUTABLE_BEFORE_PROBE")
      return value
    }
    try {
      const version = await this.probe(value.executable.path, ["--version"], home.path, generation)
      if (!/^codex-cli \d{1,4}\.\d{1,4}\.\d{1,4}(?:-[A-Za-z0-9.+-]{1,60})?$/.test(version)) throw new Error("INVALID_CODEX_VERSION")
      value.executable.version = version
      const contract = hookContractFor(value.executable.fingerprint, version, contracts)
      value.executable.probeStatus = contract ? "verified" : artifactKnown ? "version-mismatch" : "selection-required"
      if (contract) {
        value.capability = { contractId: contract.id, source: contract.source, surface: contract.surface, events: structuredClone(contract.events) }
        const features = parseHookFeatureOutput(await this.probe(value.executable.path, ["features", "list"], home.path, generation))
        // Effective CLI output outranks a user-file flag. Missing output never
        // turns an absent key into explicit false or evidence of support.
        if (features !== "unknown") value.feature = features
        if (value.feature === "disabled") value.manualFeatureInstruction = `[features]\n${contract.featureKey} = true`
      } else value.warnings.push("CAPABILITY_CONTRACT_UNKNOWN")
    } catch {
      value.executable.probeStatus = "failed"
      // A literal user-file flag is not effective feature evidence when this
      // installed CLI cannot load its config or complete the read-only probe.
      value.feature = "unknown"
      value.manualFeatureInstruction = null
      value.warnings.push("CODEX_PROBE_FAILED")
    }
    return value
  }
}
