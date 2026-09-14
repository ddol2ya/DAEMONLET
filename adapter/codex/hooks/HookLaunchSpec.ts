import { constants, createReadStream } from "node:fs"
import { access, lstat, realpath } from "node:fs/promises"
import { createHash } from "node:crypto"
import { dirname, join, posix, sep } from "node:path"
import { getCurrentFuseWire, FuseV1Options, FuseState } from "@electron/fuses"

export const HOOK_MARKER = "daemonlet-codex-pet-adapter"
export const HOOK_ARGUMENT = `--${HOOK_MARKER}=1`
export const HOOK_SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin"
// Gate 0 measured a fresh unsigned macOS launch at 1.37 s (repeats 83 ms).
// The pinned 0.147.0 contract allows 2 s for every selected event, including
// SessionEnd/Interrupt (3 s maximum). Preview explicitly discloses this change.
export const PACKAGED_HOOK_TIMEOUT_SECONDS = 2

export type HookLaunchSpec = {
  mode: "development-node" | "packaged-electron-node"
  executablePath: string
  forwarderPath: string
  dataDir: string
  hookEndpoint: string
}

// An empty environment is intentional: Node/Electron preload, inspector, proxy,
// logging and dynamic-loader variables are removed BEFORE the runtime starts.
// This list documents examples covered by regression tests; it is not a denylist.
export const DISCARDED_HOOK_ENVIRONMENT = [
  "NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "NODE_REPL_EXTERNAL_MODULE",
  "NODE_INSPECT_RESUME_ON_START", "NODE_V8_COVERAGE", "NODE_DEBUG", "NODE_DEBUG_NATIVE",
  "ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ASAR", "ELECTRON_ENABLE_LOGGING",
  "ELECTRON_LOG_FILE", "ELECTRON_LOG_ASAR_READS", "ELECTRON_ENABLE_STACK_DUMPING",
  "ELECTRON_OVERRIDE_DIST_PATH", "VSCODE_INSPECTOR_OPTIONS", "BASH_ENV", "ENV",
  "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "CODEX_PET_HOOK_TIMEOUT_MS",
] as const

export function quotePosix(value: string): string {
  if (/[\0\r\n]/.test(value)) throw new Error("INVALID_LAUNCH_VALUE")
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

export function validateLaunchSpec(spec: HookLaunchSpec): void {
  // This factory emits a POSIX shell command, including when a Windows host
  // inspects a saved macOS handler. Its grammar must not follow the test OS.
  if (!["development-node", "packaged-electron-node"].includes(spec.mode)) throw new Error("INVALID_LAUNCH_MODE")
  for (const value of [spec.executablePath, spec.forwarderPath, spec.dataDir]) {
    if (!posix.isAbsolute(value) || /[\0\r\n]/.test(value) || posix.resolve(value) !== value) throw new Error("INVALID_LAUNCH_PATH")
  }
  // Main's runtime config emits this exact IPv4 form. Keep the command factory
  // narrower than the standalone forwarder's independent loopback validator;
  // do not import its executable ES module into the Electron Main CJS bundle.
  const endpoint = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/hook$/.exec(spec.hookEndpoint)
  if (!endpoint || Number(endpoint[1]) > 65535) throw new Error("INVALID_HOOK_ENDPOINT")
  if (spec.mode === "packaged-electron-node") {
    const contents = posix.dirname(posix.dirname(spec.executablePath))
    if (!contents.endsWith(".app/Contents") || posix.dirname(spec.executablePath) !== posix.join(contents, "MacOS")
      || spec.forwarderPath !== posix.join(contents, "Resources", "codex", "hook-forwarder.mjs")) {
      throw new Error("INVALID_PACKAGE_LAYOUT")
    }
  }
}

export function createHookCommand(spec: HookLaunchSpec): string {
  validateLaunchSpec(spec)
  const environment = [
    `PATH=${HOOK_SYSTEM_PATH}`,
    ...(spec.mode === "packaged-electron-node" ? ["ELECTRON_RUN_AS_NODE=1"] : []),
    `CODEX_PET_DATA_DIR=${spec.dataDir}`,
    `CODEX_PET_HOOK_URL=${spec.hookEndpoint}`,
    "CODEX_PET_HOOK_TIMEOUT_MS=250",
  ]
  return `/usr/bin/env -i ${[...environment, spec.executablePath, spec.forwarderPath, HOOK_ARGUMENT].map(quotePosix).join(" ")}`
}

export function legacyHookCommands(executablePath: string, forwarderPath: string): { command: string; commandWindows: string } {
  const quoteWindows = (value: string) => `"${value.replaceAll('"', '\\"')}"`
  return {
    command: `${quotePosix(executablePath)} ${quotePosix(forwarderPath)} # ${HOOK_MARKER}`,
    commandWindows: `${quoteWindows(executablePath)} ${quoteWindows(forwarderPath)} & rem ${HOOK_MARKER}`,
  }
}

export const hashText = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex")

export async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest("hex")
}

export function isTemporaryInstallPath(path: string): boolean {
  return /(?:^|\/)(?:tmp|private\/tmp|var\/folders|private\/var\/folders|Volumes|AppTranslocation|Downloads|out|work|worktrees|\.worktrees|dist-electron)(?:\/|$)/i.test(path)
}

export type HookHostInspection = {
  available: boolean
  reason: "ready" | "host-unavailable" | "run-as-node-disabled" | "invalid-layout"
  fingerprint: string | null
  runAsNode: "enabled" | "disabled" | "not-applicable" | "unknown"
  temporaryLocation: boolean
}

export async function hookHostRevision(spec: HookLaunchSpec): Promise<string> {
  const paths = [spec.executablePath, spec.forwarderPath]
  if (spec.mode === "packaged-electron-node") paths.push(join(dirname(dirname(spec.executablePath)), "Frameworks/Electron Framework.framework/Electron Framework"))
  try {
    const values = await Promise.all(paths.map(async (path) => {
      const canonical = await realpath(path)
      const stat = await lstat(canonical)
      return [canonical, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode, stat.uid]
    }))
    return hashText(JSON.stringify(values))
  } catch { return "unavailable" }
}

export async function inspectHookHost(spec: HookLaunchSpec): Promise<HookHostInspection> {
  const result: HookHostInspection = {
    available: false, reason: "host-unavailable", fingerprint: null,
    runAsNode: spec.mode === "development-node" ? "not-applicable" : "unknown",
    temporaryLocation: isTemporaryInstallPath(spec.executablePath),
  }
  try {
    validateLaunchSpec(spec)
    if (spec.mode === "development-node" && /\.app\/Contents\/MacOS\//.test(spec.executablePath)) return result
    for (const [path, permission] of [[spec.executablePath, constants.X_OK], [spec.forwarderPath, constants.R_OK]] as const) {
      const stat = await lstat(path)
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0 || await realpath(path) !== path) return result
      await access(path, permission)
    }
    let frameworkFingerprint = ""
    if (spec.mode === "packaged-electron-node") {
      if (process.platform !== "darwin") return result
      const bundle = dirname(dirname(dirname(spec.executablePath)))
      const wire = await getCurrentFuseWire(bundle)
      if (wire[FuseV1Options.RunAsNode] !== FuseState.ENABLE) {
        return { ...result, runAsNode: "disabled", reason: "run-as-node-disabled" }
      }
      result.runAsNode = "enabled"
      const framework = await realpath(join(bundle, "Contents/Frameworks/Electron Framework.framework/Electron Framework"))
      if (!framework.startsWith(`${bundle}${sep}`)) return result
      frameworkFingerprint = await hashFile(framework)
    }
    result.fingerprint = hashText(JSON.stringify({ spec, executable: await hashFile(spec.executablePath), resource: await hashFile(spec.forwarderPath), frameworkFingerprint }))
    return { ...result, available: true, reason: "ready" }
  } catch {
    return result
  }
}
