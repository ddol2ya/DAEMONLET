import { constants, createReadStream } from "node:fs"
import { access, lstat, realpath } from "node:fs/promises"
import { createHash } from "node:crypto"
import { dirname, join, posix, win32, sep } from "node:path"
import { getCurrentFuseWire, FuseV1Options, FuseState } from "@electron/fuses"

export const HOOK_MARKER = "daemonlet-codex-pet-adapter"
export const HOOK_ARGUMENT = `--${HOOK_MARKER}=1`
export const HOOK_SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin"
// Gate 0 measured a fresh unsigned macOS launch at 1.37 s (repeats 83 ms).
// The pinned 0.147.0 contract allows 2 s for every selected event, including
// SessionEnd/Interrupt (3 s maximum). Preview explicitly discloses this change.
export const PACKAGED_HOOK_TIMEOUT_SECONDS = 2
// 3 s is within the reviewed Windows CLI's SessionEnd/Interrupt maximum; the native
// host's own 1.7 s child watchdog and forwarder's 650 ms watchdog stay bounded.
export const WINDOWS_HOOK_TIMEOUT_SECONDS = 3
export function hookCommandTimeoutSeconds(spec: HookLaunchSpec): number {
  return spec.mode === "packaged-windows-host" ? WINDOWS_HOOK_TIMEOUT_SECONDS : spec.mode === "packaged-electron-node" ? PACKAGED_HOOK_TIMEOUT_SECONDS : 1
}

export type HookLaunchSpec = {
  mode: "development-node" | "packaged-electron-node" | "packaged-windows-host"
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
  if (spec.mode === "packaged-windows-host") {
    for (const value of [spec.executablePath, spec.forwarderPath, spec.dataDir]) {
      if (!/^[a-z]:\\/i.test(value) || win32.resolve(value) !== value || /[\x00-\x1f"%!\u2018\u2019\u201c\u201d]/.test(value) || value.length > 2048) throw new Error("INVALID_LAUNCH_PATH")
    }
    if (win32.basename(spec.executablePath) !== "hook-host.exe" || spec.forwarderPath !== win32.join(win32.dirname(spec.executablePath), "hook-forwarder.mjs") || !win32.dirname(spec.executablePath).endsWith("\\resources\\codex")) throw new Error("INVALID_PACKAGE_LAYOUT")
    if (spec.hookEndpoint !== "discover" && !/^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/hook$/.test(spec.hookEndpoint)) throw new Error("INVALID_HOOK_ENDPOINT")
    if (spec.hookEndpoint !== "discover" && Number(new URL(spec.hookEndpoint).port) > 65535) throw new Error("INVALID_HOOK_ENDPOINT")
    return
  }
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
  if (spec.mode === "packaged-windows-host") {
    // A quoted executable path is an invocation in CMD but only a string in
    // PowerShell. An unquoted, absolute system executable plus ASCII arguments
    // works in both. Encode only our generated invocation, never user code.
    const invocation = `& '${spec.executablePath.replaceAll("'", "''")}' ${windowsHookArguments(spec).map(value => `'${value}'`).join(" ")}`
    const command = `${windowsHookShellPath()} -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(invocation, "utf16le").toString("base64")}`
    // CMD has the smaller command-line limit (8191), including its /c wrapper.
    if (command.length > 8000) throw new Error("INVALID_LAUNCH_PATH")
    return command
  }
  const environment = [
    `PATH=${HOOK_SYSTEM_PATH}`,
    ...(spec.mode === "packaged-electron-node" ? ["ELECTRON_RUN_AS_NODE=1"] : []),
    `CODEX_PET_DATA_DIR=${spec.dataDir}`,
    `CODEX_PET_HOOK_URL=${spec.hookEndpoint}`,
    "CODEX_PET_HOOK_TIMEOUT_MS=250",
  ]
  return `/usr/bin/env -i ${[...environment, spec.executablePath, spec.forwarderPath, HOOK_ARGUMENT].map(quotePosix).join(" ")}`
}

export function windowsHookShellPath(): string {
  const root = process.env.SystemRoot ?? "C:\\Windows"
  // This token must be literal without quoting in both shells. Do not fall
  // back to PATH lookup or interpolate an unsupported system directory.
  if (!/^[a-z]:\\[a-z0-9_\\.-]+$/i.test(root) || win32.resolve(root) !== root) throw new Error("INVALID_SYSTEM_SHELL_PATH")
  return win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
}

export function resemblesEncodedWindowsHook(command: string): boolean {
  // Recognition is only for refusing an unowned/altered definition. Decoding
  // does not confer ownership and this function never evaluates the payload.
  const encoded = /(?:^|\s)-EncodedCommand ([A-Za-z0-9+/=]{1,8000})(?:\s|$)/i.exec(command)?.[1]
  if (!encoded) return false
  const invocation = Buffer.from(encoded, "base64").toString("utf16le")
  return invocation.includes("hook-host.exe") && invocation.includes(HOOK_ARGUMENT)
}

export function containsHookMarker(value: unknown): boolean {
  const pending = [value]
  while (pending.length) {
    const item = pending.pop()
    if (typeof item === "string" && (item.includes(HOOK_MARKER) || resemblesEncodedWindowsHook(item))) return true
    if (item && typeof item === "object") pending.push(...Object.values(item))
  }
  return false
}

export function windowsHookArguments(spec: HookLaunchSpec): string[] {
  validateLaunchSpec(spec)
  const encode = (value: string) => Array.from({ length: value.length }, (_, i) => value.charCodeAt(i).toString(16).padStart(4, "0")).join("")
  return [encode(spec.dataDir), encode(spec.hookEndpoint), HOOK_ARGUMENT]
}
export function windowsElectronPath(spec: HookLaunchSpec): string { return win32.join(win32.dirname(win32.dirname(win32.dirname(spec.executablePath))), "Daemonlet for Codex.exe") }

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
  return /(?:^|\/)(?:tmp|private\/tmp|var\/folders|private\/var\/folders|Volumes|AppTranslocation|Downloads|out|work|worktrees|\.worktrees|dist-electron)(?:\/|$)/i.test(path.replaceAll("\\", "/"))
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
  if (spec.mode === "packaged-windows-host") paths.push(windowsElectronPath(spec))
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
    for (const [path, permission] of [[spec.executablePath, constants.X_OK], [spec.forwarderPath, constants.R_OK], ...(spec.mode === "packaged-windows-host" ? [[windowsElectronPath(spec), constants.X_OK] as const] : [])] as const) {
      const stat = await lstat(path)
      if (!stat.isFile() || stat.isSymbolicLink() || process.platform !== "win32" && (stat.mode & 0o022) !== 0 || await realpath(path) !== path) return result
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
    if (spec.mode === "packaged-windows-host") {
      if (process.platform !== "win32") return result
      const wire = await getCurrentFuseWire(windowsElectronPath(spec))
      if (wire[FuseV1Options.RunAsNode] !== FuseState.ENABLE) return { ...result, runAsNode: "disabled", reason: "run-as-node-disabled" }
      result.runAsNode = "enabled"
      frameworkFingerprint = await hashFile(windowsElectronPath(spec))
    }
    result.fingerprint = hashText(JSON.stringify({ spec, executable: await hashFile(spec.executablePath), resource: await hashFile(spec.forwarderPath), frameworkFingerprint }))
    return { ...result, available: true, reason: "ready" }
  } catch {
    return result
  }
}
