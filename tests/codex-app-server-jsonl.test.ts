import { PassThrough, Writable } from "node:stream"
import { describe, expect, it, vi } from "vitest"
import { AppServerJsonlClient } from "../adapter/codex/app-server/AppServerJsonlClient.ts"

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
