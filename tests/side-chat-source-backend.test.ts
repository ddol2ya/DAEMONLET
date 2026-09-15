import { expect, it, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { PassThrough } from "node:stream"
import { CodexSideChatBackend, type ChatConnection } from "../electron/main/side-chat/SideChatBackend"
import { AppServerJsonlClient } from "../adapter/codex/app-server/AppServerJsonlClient"
import { compilePersona } from "../electron/main/side-chat/PersonaCompiler"
import { neutralPersona } from "../electron/shared/character-persona"
const persona = compilePersona("fixture", neutralPersona(), "ko")
const parent = { threadId: randomUUID(), title: "parent", cwd: "/fixture" }
const source = { format: "paginated" as const, path: "/fixture/source.jsonl", readOnlySource: { sourceHome: "/fixture", sourceIdentity: "12:34" } }
const snapshot = { terminalTurnId: randomUUID(), contextAt: 1000, sourceIdentity: "12:34", snapshotSha256: "a".repeat(64), endOrdinalExclusive: 3, endByteOffset: 4000, sourceFiles: 1, scannedBytes: 4000, contextBytes: 3000 }
function fixture(sourceSnapshot: object = snapshot) {
  const client = { handshakeState: "READY", onClose: () => () => {}, onServerRequest: () => () => {}, onNotification: () => () => {}, request: vi.fn(async () => ({ thread: { id: randomUUID(), ephemeral: true }, sourceSnapshot })) }
  const connection = { client: client as unknown as AppServerJsonlClient, parentContext: async () => source, stop: vi.fn(async () => {}) } satisfies ChatConnection
  const backend = new CodexSideChatBackend(async () => connection)
  return { client, connection, backend }
}
it("uses only the Main source binding and actual native boundary without destination lookups", async () => {
  const f = fixture(), result = await f.backend.open(parent, persona)
  expect(result).toMatchObject({ lastTurnId: snapshot.terminalTurnId, contextAt: 1000000 })
  expect(f.client.request.mock.calls).toHaveLength(1)
  expect(f.client.request).toHaveBeenCalledWith("thread/fork", expect.objectContaining({ path: source.path, readOnlySource: source.readOnlySource, ephemeral: true, excludeTurns: true }))
  const params = (f.client.request.mock.calls as unknown as [string, Record<string, unknown>][])[0][1]
  expect(params).not.toHaveProperty("lastTurnId")
  await f.backend.close()
})
it("rejects an unbound snapshot before making the child sendable", async () => {
  const f = fixture({ ...snapshot, sourceIdentity: "other" })
  await expect(f.backend.open(parent, persona)).rejects.toThrow("SOURCE_BOUNDARY")
  expect(f.backend.isSessionOpen()).toBe(false)
  await expect(f.backend.send("never sent")).rejects.toThrow("SESSION_LOST")
  await f.backend.close()
})
it("a late source preparation cannot fork after reset", async () => {
  const f = fixture(); let finish!: (value: typeof source) => void
  f.connection.parentContext = () => new Promise(resolve => { finish = resolve })
  const opening = f.backend.open(parent, persona)
  await new Promise(resolve => setImmediate(resolve)); await f.backend.close(); finish(source)
  await expect(opening).rejects.toThrow("SESSION_LOST")
  expect(f.client.request).not.toHaveBeenCalled()
})
it("preserves only exact source codes for fork RPC errors", async () => {
  for (const [method, message, expected] of [["thread/fork", "SOURCE_CHANGED", "SOURCE_CHANGED"], ["thread/fork", "SOURCE_CHANGED private-path", "app-server request failed"], ["thread/read", "SOURCE_CHANGED", "app-server request failed"]]) {
    const input = new PassThrough(), output = new PassThrough(), client = new AppServerJsonlClient({ readable: input, writable: output })
    output.on("data", bytes => { const req = JSON.parse(bytes.toString()); input.write(JSON.stringify({ id: req.id, error: { code: -32600, message } }) + "\n") })
    await expect(client.request(method, {})).rejects.toThrow(expected)
    client.close()
  }
})
