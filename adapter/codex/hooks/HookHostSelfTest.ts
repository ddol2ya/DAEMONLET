import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { createServer, type Server } from "node:http"
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHookCommand, HOOK_SYSTEM_PATH, PACKAGED_HOOK_TIMEOUT_SECONDS, hookCommandTimeoutSeconds, inspectHookHost, windowsHookShellPath, type HookLaunchSpec } from "./HookLaunchSpec.ts"

export type HookCommandResult = {
  hostStarted: boolean
  outputContract: boolean
  wallTimeMs: number
  timedOut: boolean
  cleanedUp: boolean
}

// Deliberately no public stdout/stderr. Even an OS or shell error may contain
// private filesystem paths or inherited environment values.
export async function runHookCommand(spec: HookLaunchSpec, input: string, options: {
  signal?: AbortSignal
  holdStdin?: boolean
  environment?: NodeJS.ProcessEnv
  windowsShell?: "powershell" | "cmd"
} = {}): Promise<HookCommandResult> {
  const command = createHookCommand(spec)
  const startedAt = performance.now()
  return new Promise((resolveResult) => {
    let stdout = "", stderr = "", timedOut = false, settled = false
    // Match the reviewed Windows CLI's derive_exec_args(..., false), including
    // PowerShell's parsing and normal Windows argument quoting. CMD-only probes
    // can pass commands that fail before the native host starts in the CLI.
    const windows = spec.mode === "packaged-windows-host", cmd = windows && options.windowsShell === "cmd"
    const child = spawn(windows ? cmd ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe") : windowsHookShellPath() : "/bin/sh", windows ? cmd ? ["/d", "/c", `"${command}"`] : ["-NoProfile", "-Command", command] : ["-c", command], {
      cwd: windows ? tmpdir() : "/", windowsHide: true, windowsVerbatimArguments: cmd, env: options.environment ?? { PATH: HOOK_SYSTEM_PATH },
      detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
    })
    const terminate = () => {
      if (child.pid) {
        try { process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL") } catch { /* already reaped */ }
      }
    }
    const timeout = setTimeout(() => { timedOut = true; terminate() }, hookCommandTimeoutSeconds(spec) * 1000)
    const abort = () => { timedOut = true; terminate() }
    options.signal?.addEventListener("abort", abort, { once: true })
    if (options.signal?.aborted) abort()
    const finish = (hostStarted: boolean, code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      options.signal?.removeEventListener("abort", abort)
      resolveResult({ hostStarted, outputContract: code === 0 && stdout === "{}\n" && stderr === "", wallTimeMs: Math.round(performance.now() - startedAt), timedOut, cleanedUp: true })
    }
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); if (stdout.length > 4096) terminate() })
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); if (stderr.length > 4096) terminate() })
    child.stdin.on("error", () => { /* early exit after rejected input is expected */ })
    child.once("error", () => finish(false, null))
    child.once("close", (code) => finish(code === 0, code))
    if (options.holdStdin) child.stdin.write(input)
    else child.stdin.end(input)
  })
}

export type PublicSelfTestResult = {
  source: "synthetic-packaged" | "unit"
  status: "passed" | "failed" | "host-unavailable" | "not-tested"
  checkedAt: number | null
  hostFingerprint: string | null
  coldStartMs: number | null
  repeatMs: number[]
  budgetMs: number
  cases: Array<{ name: string; passed: boolean; wallTimeMs: number }>
  receiverVerified: boolean
  sanitized: boolean
  cleanedUp: boolean
}

export function notTestedHost(): PublicSelfTestResult {
  return { source: "synthetic-packaged", status: "not-tested", checkedAt: null, hostFingerprint: null, coldStartMs: null, repeatMs: [], budgetMs: PACKAGED_HOOK_TIMEOUT_SECONDS * 1000, cases: [], receiverVerified: false, sanitized: false, cleanedUp: true }
}

const fixture = JSON.stringify({
  hook_event_name: "UserPromptSubmit", session_id: "synthetic-session", turn_id: "synthetic-turn",
  model: "synthetic-model", permission_mode: "default", cwd: "/private/synthetic-workspace",
  transcript_path: "/private/synthetic-transcript", prompt: "SELFTEST_PRIVATE_CANARY",
  tool_input: "SELFTEST_PRIVATE_CANARY", tool_response: "SELFTEST_PRIVATE_CANARY",
})
const expectedPayload = { payloadVersion: 1, hookEventName: "UserPromptSubmit", sessionId: "synthetic-session", model: "synthetic-model", permissionMode: "default", turnId: "synthetic-turn" }

export async function runHookHostSelfTest(spec: HookLaunchSpec, signal?: AbortSignal): Promise<PublicSelfTestResult> {
  const result = { ...notTestedHost(), source: spec.mode !== "development-node" ? "synthetic-packaged" as const : "unit" as const, checkedAt: Date.now(), budgetMs: hookCommandTimeoutSeconds(spec) * 1000 }
  const inspection = await inspectHookHost(spec)
  result.hostFingerprint = inspection.fingerprint
  if (!inspection.available || signal?.aborted) return { ...result, status: "host-unavailable" }
  const directory = await realpath(await mkdtemp(join(tmpdir(), "daemonlet-hook-selftest-")))
  const tokenPath = join(directory, "adapter-token")
  const token = randomBytes(32).toString("hex")
  const servers: Server[] = []
  let received = 0, sanitized = true, redirected = 0
  let receiverMode: "accept" | "redirect" | "stall" = "accept"
  const listen = async (server: Server): Promise<number> => {
    servers.push(server)
    await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done) })
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("SELFTEST_RECEIVER_UNAVAILABLE")
    return address.port
  }
  const close = async (server: Server) => {
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
  }
  try {
    await chmod(directory, 0o700)
    await writeFile(tokenPath, `${token}\n`, { mode: 0o600 })
    const redirectPort = await listen(createServer((request, response) => { redirected++; request.resume(); response.end() }))
    const receiver = createServer((request, response) => {
      let body = ""
      request.on("data", (chunk) => { body += chunk; if (body.length > 65536) request.destroy() })
      request.on("error", () => {})
      request.on("end", () => {
        received++
        sanitized &&= request.method === "POST" && request.url === "/hook" && request.headers.authorization === `Bearer ${token}` && body === JSON.stringify(expectedPayload)
        if (receiverMode === "stall") return
        response.writeHead(receiverMode === "redirect" ? 307 : 202, receiverMode === "redirect" ? { location: `http://127.0.0.1:${redirectPort}/collect` } : {})
        response.end()
      })
    })
    const port = await listen(receiver)
    const testSpec = { ...spec, dataDir: directory, hookEndpoint: `http://127.0.0.1:${port}/hook` }
    const check = async (name: string, input: string, expectedReceipts: number, holdStdin = false, windowsShell: "powershell" | "cmd" = "powershell") => {
      if (signal?.aborted) throw new Error("SELFTEST_CANCELLED")
      const before = received
      const outcome = await runHookCommand(testSpec, input, {
        signal, holdStdin, windowsShell,
        // PowerShell requires PATHEXT even for an absolute .exe path. Keep
        // only that OS dispatch prerequisite; the native host still clears
        // it along with all runtime-affecting values before Electron starts.
        environment: { PATH: HOOK_SYSTEM_PATH, ...(spec.mode === "packaged-windows-host" ? { PATHEXT: ".EXE" } : {}), NODE_OPTIONS: "--require /missing/private-preload.cjs", NODE_PATH: "/missing/modules", ELECTRON_ENABLE_LOGGING: "1", ELECTRON_RUN_AS_NODE: "0", CODEX_PET_DATA_DIR: "/missing/wrong-data", CODEX_PET_HOOK_URL: "https://example.invalid/never" },
      })
      result.cases.push({ name, passed: outcome.outputContract && !outcome.timedOut && outcome.wallTimeMs < result.budgetMs && received - before === expectedReceipts, wallTimeMs: outcome.wallTimeMs })
      return outcome.wallTimeMs
    }
    result.coldStartMs = await check("cold-start-sanitized-delivery", fixture, 1)
    for (let index = 0; index < 3; index++) result.repeatMs.push(await check(`repeat-${index + 1}`, fixture, 1))
    if (spec.mode === "packaged-windows-host") {
      await check("cmd-cold-start-sanitized-delivery", fixture, 1, false, "cmd")
      for (let index = 0; index < 3; index++) await check(`cmd-repeat-${index + 1}`, fixture, 1, false, "cmd")
    }
    result.receiverVerified = received === (spec.mode === "packaged-windows-host" ? 8 : 4)
    await check("malformed-json", "{", 0)
    await check("oversized-body", "x".repeat(65537), 0)
    await check("stdin-watchdog", fixture, 0, true)
    await rm(tokenPath)
    await check("missing-token", fixture, 0)
    await writeFile(tokenPath, token, { mode: 0o600 })
    receiverMode = "redirect"
    await check("redirect-rejected", fixture, 1)
    result.cases.push({ name: "no-redirect-follow", passed: redirected === 0, wallTimeMs: 0 })
    receiverMode = "stall"
    await check("receiver-timeout", fixture, 1)
    await close(receiver)
    await check("adapter-offline-no-autostart", fixture, 0)
    result.sanitized = sanitized
    result.status = result.receiverVerified && sanitized && result.cases.every((item) => item.passed) ? "passed" : "failed"
  } catch {
    result.status = signal?.aborted ? "not-tested" : "failed"
  } finally {
    await Promise.all(servers.map(close))
    await rm(directory, { recursive: true, force: true })
  }
  return result
}
