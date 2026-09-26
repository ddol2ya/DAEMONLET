import { PassThrough, Writable } from "node:stream"
import { describe, expect, it, vi } from "vitest"
import { AppServerJsonlClient, AppServerRpcError } from "../adapter/codex/app-server/AppServerJsonlClient.ts"

const setup = (timeout = 100) => {
  const readable = new PassThrough()
  const writable = new PassThrough()
  const client = new AppServerJsonlClient({ readable, writable, requestTimeoutMs: timeout, maxLineBytes: 256 })
  return { readable, writable, client }
}

describe("AppServerJsonlClient", () => {
  it("parses partial, multiple, CRLF, empty, malformed, response, and notification lines", async () => {
    const { readable, writable, client } = setup()
    const notifications = vi.fn()
    client.onNotification(notifications)
    const request = client.request("thread/list")
    const outgoing = await new Promise<string>((resolve) => writable.once("data", (data) => resolve(data.toString())))
    const id = JSON.parse(outgoing).id
    readable.write(`{"method":"turn/started","params":{"safe":true}}\r\n\n{"id":${id},"res`)
    readable.write('ult":{"ok":true}}\n{broken}\n')
    await expect(request).resolves.toEqual({ ok: true })
    expect(notifications).toHaveBeenCalledWith("turn/started", { safe: true })
    expect(client.lastError).toBe("app-server emitted malformed JSONL")
  })

  it("times out requests, rejects pending work on exit, and bounds lines", async () => {
    const first = setup(10)
    await expect(first.client.request("slow")).rejects.toThrow("timed out")
    const second = setup()
    const pending = second.client.request("pending")
    second.readable.end()
    await expect(pending).rejects.toThrow("stdout ended")
    const third = setup()
    third.readable.write("x".repeat(300))
    expect(third.client.handshakeState).toBe("CLOSED")
    expect(third.client.lastError).toContain("maximum")
  })

  it("performs initialize then initialized without experimental capabilities", async () => {
    const { readable, writable, client } = setup()
    const messages: unknown[] = []
    writable.on("data", (data) => {
      for (const line of data.toString().trim().split("\n")) {
        const message = JSON.parse(line)
        messages.push(message)
        if (message.method === "initialize") readable.write(`${JSON.stringify({ id: message.id, result: { userAgent: "test" } })}\n`)
      }
    })
    await client.initialize({ name: "n", title: "t", version: "v" })
    expect(messages).toMatchObject([
      { method: "initialize", params: { capabilities: { experimentalApi: false } } },
      { method: "initialized" },
    ])
    expect(client.handshakeState).toBe("READY")
  })
})


it("rejects a failed transport write without leaving an orphaned response rejection", async () => {
  const readable = new PassThrough()
  const writable = new Writable({ write(_chunk, _encoding, callback) { callback(new Error("broken pipe")) } })
  const client = new AppServerJsonlClient({ readable, writable, requestTimeoutMs: 500 })
  await expect(client.request("turn/interrupt", { threadId: "safe", turnId: "exact" })).rejects.toThrow("broken pipe")
  expect(client.pendingRequestCount).toBe(0)
  client.close()
})

it("preserves only numeric RPC codes and releases transport listeners", async () => {
  const { client, readable, writable } = setup()
  const pending = client.request("account/rateLimits/read")
  const outgoing = await new Promise<string>(resolve => writable.once("data", data => resolve(data.toString())))
  const id = JSON.parse(outgoing).id
  readable.write(JSON.stringify({ id, error: { code: -32602, message: "private-token", data: { path: "/private/account" } } }) + "\n")
  const error = await pending.catch(e => e)
  expect(error).toBeInstanceOf(AppServerRpcError); if (!(error instanceof AppServerRpcError)) throw Error("missing safe RPC error")
  expect(error.code).toBe(-32602)
  expect(error.message).toBe("app-server request failed"); expect(JSON.stringify(error)).not.toMatch(/private/)
  client.close(); expect(readable.listenerCount("data")).toBe(0); expect(readable.listenerCount("end")).toBe(0)
  expect(writable.listenerCount("drain")).toBe(0)
})

it.each(["late-write", "readable-end", "readable-error", "backpressure"])("survives %s during close in an isolated Node process", async scenario => {
  const { mkdtemp, rm } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const { join, resolve } = await import("node:path")
  const { execFile } = await import("node:child_process")
  const { promisify } = await import("node:util")
  const { build } = await import("esbuild")
  const root = await mkdtemp(join(tmpdir(), "jsonl-stream-lifetime-"))
  try {
    const outfile = join(root, "repro.mjs")
    await build({ entryPoints: [resolve("tests/fixtures/app-server/stream-lifetime.ts")], outfile, bundle: true, platform: "node", format: "esm", logLevel: "silent" })
    const result = await promisify(execFile)(process.execPath, ["--unhandled-rejections=strict", outfile, scenario], { timeout: 3000 })
    expect(result.stdout.trim()).toBe("stream-lifetime:passed")
    expect(result.stderr).toBe("")
  } finally { await rm(root, { recursive: true, force: true }) }
})

it("keeps one passive guard for a shared duplex and releases it at physical close", async () => {
  const stream = new PassThrough()
  const client = new AppServerJsonlClient({ readable: stream, writable: stream })
  client.close(); client.close()
  expect(stream.listenerCount("error")).toBe(1)
  stream.destroy(new Error("late duplex failure"))
  await new Promise<void>(resolve => stream.once("close", resolve))
  expect(stream.listenerCount("error")).toBe(0)
})
