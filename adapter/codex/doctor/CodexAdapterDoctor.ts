import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { createConnection } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { HOOK_MARKER, INSTALLED_HOOK_EVENTS } from "../hooks/HookInstaller.ts"
import { inspectAttachFeasibility } from "../app-server/AppServerAttachProbe.ts"

const execFileAsync = promisify(execFile)

export type DoctorReport = {
  checkedAt: number
  codex: { path: string | null; version: string | null; appServer: boolean; schemaGeneration: boolean; schemaHash: string | null }
  hooks: { featureEnabled: boolean | null; fileValid: boolean; installed: boolean; trusted: null; note: string }
  permissions: { dataDirectory: string; dataDirectoryMode: string | null; tokenMode: string | null; warnings: string[] }
  ports: { protocol4174: "available" | "listening" | "unknown"; hook4175: "available" | "listening" | "unknown" }
  attach: Awaited<ReturnType<typeof inspectAttachFeasibility>> | null
  warnings: string[]
}

async function command(path: string, args: string[], timeout = 10_000): Promise<string> {
  return (await execFileAsync(path, args, { timeout, maxBuffer: 2 * 1024 * 1024 })).stdout.trim()
}

async function findCodex(preferred?: string): Promise<string | null> {
  if (preferred) {
    try { await access(preferred); return preferred } catch {}
  }
  try { return await command("which", ["codex"], 2_000) } catch { return null }
}

async function mode(path: string): Promise<string | null> {
  try { return ((await stat(path)).mode & 0o777).toString(8).padStart(3, "0") } catch { return null }
}

async function portState(port: number): Promise<"available" | "listening" | "unknown"> {
  const connected = await new Promise<"available" | "listening" | "restricted">((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port })
    const finish = (state: "available" | "listening" | "restricted") => { socket.destroy(); resolve(state) }
    socket.setTimeout(300)
    socket.once("connect", () => finish("listening"))
    socket.once("timeout", () => finish("restricted"))
    socket.once("error", (error: NodeJS.ErrnoException) => finish(error.code === "ECONNREFUSED" ? "available" : "restricted"))
  })
  if (connected !== "restricted") return connected
  try {
    const listeners = await command("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], 2_000)
    return listeners ? "listening" : "unknown"
  } catch { return "unknown" }
}

export async function runDoctor(options: { codexPath?: string; codexHome: string; dataDir: string }): Promise<DoctorReport> {
  const warnings: string[] = []
  const codexPath = await findCodex(options.codexPath)
  let version: string | null = null
  let appServer = false
  let schemaGeneration = false
  let schemaHash: string | null = null
  let featureEnabled: boolean | null = null
  let attach: DoctorReport["attach"] = null
  if (codexPath) {
    try { version = await command(codexPath, ["--version"]) } catch { warnings.push("Codex version check failed") }
    try { await command(codexPath, ["app-server", "--help"]); appServer = true } catch { warnings.push("Codex app-server command is unavailable") }
    try {
      const features = await command(codexPath, ["features", "list"])
      const line = features.split("\n").find((item) => item.trim().startsWith("hooks"))
      featureEnabled = line ? /\btrue\s*$/.test(line) : null
    } catch { warnings.push("Codex hooks feature status is unavailable") }
    const output = await mkdtemp(join(tmpdir(), "daemonlet-schema-doctor-"))
    try {
      await command(codexPath, ["app-server", "generate-json-schema", "--out", output], 30_000)
      const schema = await readFile(join(output, "codex_app_server_protocol.v2.schemas.json"))
      schemaHash = createHash("sha256").update(schema).digest("hex")
      schemaGeneration = true
    } catch { warnings.push("App Server schema generation failed") } finally { await rm(output, { recursive: true, force: true }) }
    attach = await inspectAttachFeasibility(codexPath)
  } else warnings.push("Codex binary was not found")

  const hooksPath = join(options.codexHome, "hooks.json")
  let hooksFileValid = true
  let installed = false
  try {
    const hooks = JSON.parse(await readFile(hooksPath, "utf8")) as { hooks?: Record<string, unknown[]> }
    installed = INSTALLED_HOOK_EVENTS.every((event) => Array.isArray(hooks.hooks?.[event]) && JSON.stringify(hooks.hooks?.[event]).includes(HOOK_MARKER))
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") hooksFileValid = true
    else { hooksFileValid = false; warnings.push("hooks.json is invalid or unreadable") }
  }

  const dataMode = await mode(options.dataDir)
  const tokenMode = await mode(join(options.dataDir, "adapter-token"))
  const permissionWarnings: string[] = []
  if (process.platform !== "win32" && dataMode && dataMode !== "700") permissionWarnings.push(`data directory mode is ${dataMode}; expected 700`)
  if (process.platform !== "win32" && tokenMode && tokenMode !== "600") permissionWarnings.push(`token mode is ${tokenMode}; expected 600`)
  const [protocol4174, hook4175] = await Promise.all([portState(4174), portState(4175)])

  return {
    checkedAt: Date.now(),
    codex: { path: codexPath, version, appServer, schemaGeneration, schemaHash },
    hooks: { featureEnabled, fileValid: hooksFileValid, installed, trusted: null, note: "Trust must be reviewed in Codex /hooks; it is not inferred from local files" },
    permissions: { dataDirectory: options.dataDir, dataDirectoryMode: dataMode, tokenMode, warnings: permissionWarnings },
    ports: { protocol4174, hook4175 },
    attach,
    warnings,
  }
}
