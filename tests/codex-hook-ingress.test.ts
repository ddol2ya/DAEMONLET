import { afterEach, describe, expect, it, vi } from "vitest"
import { HookIngressServer } from "../adapter/codex/hooks/HookIngressServer.ts"

const servers: HookIngressServer[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.stop())) })

describe("HookIngressServer", () => {
  it("binds loopback, authenticates, validates, rate-limits, and shuts down", async () => {
    const onEvent = vi.fn()
    const server = new HookIngressServer({ token: "token", port: 0, maxRequestsPerSecond: 2, onEvent })
    servers.push(server)
    await server.start()
    const url = server.getDiagnostics().endpoint
    const body = JSON.stringify({ payloadVersion: 1, sessionId: "s", model: "m", hookEventName: "SessionStart", source: "startup" })
    expect((await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body })).status).toBe(401)
    expect((await fetch(url, { method: "POST", headers: { "content-type": "text/plain", authorization: "Bearer token" }, body })).status).toBe(415)
    expect((await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer token" }, body })).status).toBe(202)
    expect(onEvent).toHaveBeenCalledOnce()
    expect((await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer token" }, body })).status).toBe(202)
    expect((await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer token" }, body })).status).toBe(429)
    expect((await fetch(url.replace("/hook", "/healthz"))).status).toBe(200)
    expect(server.getDiagnostics()).toMatchObject({ accepted: 2, authFailures: 1 })
  })

  it("refuses remote binds", () => {
    expect(() => new HookIngressServer({ token: "x", host: "0.0.0.0", onEvent: () => {} })).toThrow("127.0.0.1")
  })

  it("rejects oversized bodies and safely accepts concurrent requests", async () => {
    const events: unknown[] = []
    const server = new HookIngressServer({ token: "token", port: 0, maxRequestsPerSecond: 100, onEvent: (event) => { events.push(event) } })
    servers.push(server)
    await server.start()
    const url = server.getDiagnostics().endpoint
    const headers = { "content-type": "application/json", authorization: "Bearer token" }
    expect((await fetch(url, { method: "POST", headers, body: JSON.stringify({ padding: "x".repeat(64 * 1024) }) })).status).toBe(413)
    const body = JSON.stringify({ payloadVersion: 1, sessionId: "s", model: "m", hookEventName: "SessionStart", source: "startup" })
    const responses = await Promise.all(Array.from({ length: 12 }, () => fetch(url, { method: "POST", headers, body })))
    expect(responses.every((response) => response.status === 202)).toBe(true)
    expect(events).toHaveLength(12)
  })
})
