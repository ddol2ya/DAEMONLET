import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { timingSafeEqual } from "node:crypto"
import { MAX_HOOK_BYTES, type ValidatedHookEvent } from "./HookEventValidator.ts"
import { parseSanitizedHookIngress } from "./SanitizedHookIngress.ts"
import { emptyHookReceipts, type HookEventReceipt } from "./HookEvents.ts"

export type HookIngressOptions = {
  token: string
  host?: string
  port?: number
  maxRequestsPerSecond?: number
  onEvent: (event: ValidatedHookEvent) => void | Promise<void>
}

export type HookIngressDiagnostics = {
  endpoint: string
  accepted: number
  rejected: number
  authFailures: number
  timeouts: number
  lastEventAt: number | null
  events: HookEventReceipt[]
}

export class HookIngressServer {
  private readonly options: HookIngressOptions
  private server: Server | null = null
  private windowStartedAt = 0
  private windowCount = 0
  private readonly host: string
  private readonly port: number
  private diagnostics: HookIngressDiagnostics

  constructor(options: HookIngressOptions) {
    this.options = options
    this.host = options.host ?? "127.0.0.1"
    if (this.host !== "127.0.0.1") throw new Error("hook ingress must bind to 127.0.0.1")
    this.port = options.port ?? 4175
    this.diagnostics = { endpoint: `http://${this.host}:${this.port}/hook`, accepted: 0, rejected: 0, authFailures: 0, timeouts: 0, lastEventAt: null, events: emptyHookReceipts() }
  }

  async start(): Promise<void> {
    if (this.server) return
    const server = createServer((request, response) => void this.handle(request, response))
    server.requestTimeout = 1_000
    server.headersTimeout = 1_000
    server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"))
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(this.port, this.host, () => {
        server.off("error", reject)
        const address = server.address()
        if (address && typeof address === "object") this.diagnostics.endpoint = `http://${this.host}:${address.port}/hook`
        resolve()
      })
    })
    this.server = server
  }

  private authorized(request: IncomingMessage): boolean {
    const header = request.headers.authorization
    const expected = `Bearer ${this.options.token}`
    if (typeof header !== "string") return false
    const actualBytes = Buffer.from(header)
    const expectedBytes = Buffer.from(expected)
    return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
  }

  private rateLimited(now: number): boolean {
    if (now - this.windowStartedAt >= 1_000) {
      this.windowStartedAt = now
      this.windowCount = 0
    }
    this.windowCount++
    return this.windowCount > (this.options.maxRequestsPerSecond ?? 120)
  }

  private reply(response: ServerResponse, status: number, body = ""): void {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
    response.end(body)
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === "GET" && request.url === "/healthz") return this.reply(response, 200, '{"ok":true}')
    if (request.method !== "POST" || request.url !== "/hook") {
      this.diagnostics.rejected++
      return this.reply(response, 404, '{"error":"not-found"}')
    }
    if (!this.authorized(request)) {
      this.diagnostics.authFailures++
      this.diagnostics.rejected++
      request.resume()
      return this.reply(response, 401, '{"error":"unauthorized"}')
    }
    if (!(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      this.diagnostics.rejected++
      request.resume()
      return this.reply(response, 415, '{"error":"json-required"}')
    }
    if (this.rateLimited(Date.now())) {
      this.diagnostics.rejected++
      request.resume()
      return this.reply(response, 429, '{"error":"rate-limit"}')
    }
    const declared = Number(request.headers["content-length"] ?? 0)
    if (declared > MAX_HOOK_BYTES) {
      this.diagnostics.rejected++
      request.resume()
      return this.reply(response, 413, '{"error":"body-too-large"}')
    }
    const chunks: Buffer[] = []
    let size = 0
    let oversized = false
    request.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_HOOK_BYTES) oversized = true
      else chunks.push(chunk)
    })
    request.on("aborted", () => { this.diagnostics.timeouts++ })
    request.on("end", async () => {
      if (oversized) {
        this.diagnostics.rejected++
        return this.reply(response, 413, '{"error":"body-too-large"}')
      }
      const parsed = parseSanitizedHookIngress(Buffer.concat(chunks))
      if (!parsed.ok) {
        this.diagnostics.rejected++
        return this.reply(response, 400, JSON.stringify({ error: parsed.code }))
      }
      try {
        await this.options.onEvent(parsed.value)
        this.diagnostics.accepted++
        this.diagnostics.lastEventAt = parsed.value.observedAt
        const receipt = this.diagnostics.events.find((item) => item.event === parsed.value.hookEventName)
        if (receipt) { receipt.count = Math.min(1_000_000_000, receipt.count + 1); receipt.lastReceivedAt = Date.now() }
        this.reply(response, 202, '{}')
      } catch {
        this.diagnostics.rejected++
        this.reply(response, 500, '{"error":"ingress-failed"}')
      }
    })
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server) return
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }

  getDiagnostics(): HookIngressDiagnostics {
    return structuredClone(this.diagnostics)
  }
}
