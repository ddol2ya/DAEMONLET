import { spawn } from "node:child_process"
import { createServer, type Server } from "node:http"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { hookTimeout, parseLoopbackHookUrl } from "../adapter/codex/hooks/hook-forwarder.mjs"

const directories: string[] = []
const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const input = JSON.stringify({ session_id: "s", cwd: "/w", model: "m", hook_event_name: "UserPromptSubmit", turn_id: "t", prompt: "private prompt" })
const sanitizedInput = { payloadVersion: 1, hookEventName: "UserPromptSubmit", sessionId: "s", turnId: "t", model: "m" }
const interruptInput = JSON.stringify({ session_id: "s", transcript_path: "/private/transcript", cwd: "/w", model: "m", permission_mode: "default", hook_event_name: "Interrupt", turn_id: "t" })
const sanitizedInterrupt = { payloadVersion: 1, hookEventName: "Interrupt", sessionId: "s", turnId: "t", model: "m", permissionMode: "default" }

const runForwarder = (value: string, env: NodeJS.ProcessEnv) => new Promise<{ stdout: string; stderr: string }>((resolveResult, reject) => {
  const child = spawn(process.execPath, [resolve("adapter/codex/hooks/hook-forwarder.mjs")], { env, shell: false })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => { stdout += chunk })
  child.stderr.on("data", (chunk) => { stderr += chunk })
  child.once("error", reject)
  child.once("exit", (code) => code === 0 ? resolveResult({ stdout, stderr }) : reject(new Error(`forwarder exited ${code}`)))
  child.stdin.end(value)
})

const listen = async (server: Server, host: string): Promise<number> => {
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject)
    server.listen(0, host, () => {
      server.off("error", reject)
      resolveListen()
    })
  })
  servers.push(server)
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("missing address")
  return address.port
}

const dataDirectory = async (prefix = "forwarder-"): Promise<string> => {
  const dataDir = await mkdtemp(join(tmpdir(), prefix))
  directories.push(dataDir)
  await writeFile(join(dataDir, "adapter-token"), "test-token\n")
  return dataDir
}

describe("hook-forwarder", () => {
  it("accepts only HTTP loopback /hook URLs and clamps timeouts", () => {
    for (const value of ["http://127.0.0.1:4175/hook", "http://localhost:4175/hook", "http://[::1]:4175/hook", "http://127.0.0.1:80/hook"]) {
      expect(parseLoopbackHookUrl(value)?.pathname).toBe("/hook")
    }
    for (const value of [
      "https://example.com/hook",
      "http://192.0.2.1:4175/hook",
      "http://0.0.0.0:4175/hook",
      "http://user:pass@127.0.0.1:4175/hook",
      "http://127.0.0.1:4175/other",
      "http://127.0.0.1:4175/hook?token=x",
      "http://127.0.0.1:4175/hook#fragment",
      "http://127.0.0.1:0/hook",
      "http://127.1:4175/hook",
      "http://2130706433:4175/hook",
    ]) expect(parseLoopbackHookUrl(value)).toBeNull()
    expect(hookTimeout("invalid")).toBe(250)
    expect(hookTimeout("1")).toBe(50)
    expect(hookTimeout("5000")).toBe(1_000)
  })

  it("forwards with its bearer token to IPv4 and localhost loopback only", async () => {
    const dataDir = await dataDirectory()
    for (const host of ["127.0.0.1", "localhost"]) {
      let received = ""
      const server = createServer((request, response) => {
        expect(request.headers.authorization).toBe("Bearer test-token")
        expect(request.url).toBe("/hook")
        request.on("data", (chunk) => { received += chunk })
        request.on("end", () => { response.writeHead(202); response.end() })
      })
      const port = await listen(server, host)
      const result = await runForwarder(input, { ...process.env, CODEX_PET_DATA_DIR: dataDir, CODEX_PET_HOOK_URL: `http://${host}:${port}/hook` })
      expect(result).toEqual({ stdout: "{}\n", stderr: "" })
      expect(JSON.parse(received)).toEqual(sanitizedInput)
      expect(received).not.toMatch(/private prompt|\/w|prompt|cwd/)
    }
  })

  it("forwards to IPv6 loopback when the platform supports it", async () => {
    const dataDir = await dataDirectory("forwarder-ipv6-")
    let received = ""
    const server = createServer((request, response) => {
      request.on("data", (chunk) => { received += chunk })
      request.on("end", () => { response.writeHead(202); response.end() })
    })
    let port: number
    try { port = await listen(server, "::1") } catch { return }
    const result = await runForwarder(input, { ...process.env, CODEX_PET_DATA_DIR: dataDir, CODEX_PET_HOOK_URL: `http://[::1]:${port}/hook` })
    expect(result).toEqual({ stdout: "{}\n", stderr: "" })
    expect(JSON.parse(received)).toEqual(sanitizedInput)
  })

  it("forwards an Interrupt without leaking its transcript or working directory", async () => {
    const dataDir = await dataDirectory("forwarder-interrupt-")
    let received = ""
    const server = createServer((request, response) => {
      request.on("data", (chunk) => { received += chunk })
      request.on("end", () => { response.writeHead(202); response.end() })
    })
    const port = await listen(server, "127.0.0.1")
    const result = await runForwarder(interruptInput, { ...process.env, CODEX_PET_DATA_DIR: dataDir, CODEX_PET_HOOK_URL: `http://127.0.0.1:${port}/hook` })
    expect(result).toEqual({ stdout: "{}\n", stderr: "" })
    expect(JSON.parse(received)).toEqual(sanitizedInterrupt)
    expect(received).not.toMatch(/private|transcript|\/w|cwd/)
  })

  it("rejects non-loopback, credentialed, and non-canonical endpoints without any request", async () => {
    const dataDir = await dataDirectory("forwarder-rejected-")
    let requestCount = 0
    const server = createServer((_request, response) => { requestCount++; response.writeHead(202); response.end() })
    const port = await listen(server, "127.0.0.1")
    const rejected = [
      "https://example.com/hook",
      "http://192.0.2.1:4175/hook",
      `http://0.0.0.0:${port}/hook`,
      `http://user:pass@127.0.0.1:${port}/hook`,
      `http://127.0.0.1:${port}/other`,
      `http://127.0.0.1:${port}/hook?token=x`,
      `http://127.0.0.1:${port}/hook#fragment`,
    ]
    for (const endpoint of rejected) {
      const result = await runForwarder(input, { ...process.env, CODEX_PET_DATA_DIR: dataDir, CODEX_PET_HOOK_URL: endpoint, CODEX_PET_HOOK_TIMEOUT_MS: "50" })
      expect(result).toEqual({ stdout: "{}\n", stderr: "" })
    }
    expect(requestCount).toBe(0)
  })

  it("does not follow redirects away from the configured loopback endpoint", async () => {
    const dataDir = await dataDirectory("forwarder-redirect-")
    let redirectedRequests = 0
    const target = createServer((_request, response) => { redirectedRequests++; response.writeHead(204); response.end() })
    const targetPort = await listen(target, "127.0.0.1")
    let sourceRequests = 0
    const source = createServer((request, response) => {
      sourceRequests++
      request.resume()
      response.writeHead(307, { location: `http://127.0.0.1:${targetPort}/collect` })
      response.end()
    })
    const sourcePort = await listen(source, "127.0.0.1")
    const result = await runForwarder(input, { ...process.env, CODEX_PET_DATA_DIR: dataDir, CODEX_PET_HOOK_URL: `http://127.0.0.1:${sourcePort}/hook` })
    expect(result).toEqual({ stdout: "{}\n", stderr: "" })
    expect(sourceRequests).toBe(1)
    expect(redirectedRequests).toBe(0)
  })

  it("does not block or leak when the adapter is unavailable or input is invalid", async () => {
    const dataDir = await dataDirectory("forwarder-offline-")
    for (const value of [input, "{"]) {
      const result = await runForwarder(value, { ...process.env, CODEX_PET_DATA_DIR: dataDir, CODEX_PET_HOOK_URL: "http://127.0.0.1:9/hook", CODEX_PET_HOOK_TIMEOUT_MS: "20" })
      expect(result.stdout).toBe("{}\n")
      expect(result.stderr).toBe("")
      expect(`${result.stdout}${result.stderr}`).not.toContain("private prompt")
    }
  })
})
