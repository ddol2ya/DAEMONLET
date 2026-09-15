import { afterEach, expect, it } from "vitest"
import { mkdtemp, mkdir, writeFile, rm, realpath, truncate } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import { inspectChatSource, resolveChatParentSource, validateSourceSnapshot } from "../electron/main/side-chat/SideChatSource"
import { safeSourceError } from "../adapter/codex/app-server/SourceError"
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture(meta: object = {}) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "paginated-source-"))); roots.push(home)
  await mkdir(join(home, "sessions"))
  const id = randomUUID(), path = join(home, "sessions", `rollout-2026-09-16T00-00-00-${id}.jsonl`)
  await writeFile(path, JSON.stringify({ type: "session_meta", payload: { id, history_mode: "paginated", ...meta } }) + "\n", { mode: 0o600 })
  return { home, path, parent: { threadId: id, path, title: "fixture", cwd: home } }
}
it("bounds metadata reads independently of total paginated store size and cannot claim a boundary", async () => {
  const f = await fixture(); await truncate(f.path, 256 * 1024 * 1024)
  const result = await inspectChatSource(f.home, f.parent)
  expect(result).toMatchObject({ format: "paginated", capabilities: false, readOnlySource: { sourceHome: f.home } })
  expect(result.readOnlySource.sourceIdentity).toMatch(/^\d+:\d+$/)
  expect(result).not.toHaveProperty("lastTurnId")
  await expect(resolveChatParentSource(f.home, f.parent, "legacy")).rejects.toThrow("SOURCE_RUNTIME_UNSUPPORTED")
})
it("rejects capabilities, wrong logical identity and outside-home paths before native fork", async () => {
  for (const meta of [{ dynamic_tools: [{ name: "private" }] }, { selected_capability_roots: [{ path: "private" }] }]) {
    const f = await fixture(meta)
    await expect(resolveChatParentSource(f.home, f.parent, "read-only-source-v1")).rejects.toThrow("PARENT_CAPABILITIES")
  }
  const f = await fixture({ id: randomUUID() })
  await expect(inspectChatSource(f.home, f.parent)).rejects.toThrow("SOURCE_IDENTITY")
  await expect(inspectChatSource(join(f.home, "elsewhere"), f.parent)).rejects.toThrow("SOURCE_SCOPE")
})
it.skipIf(process.platform !== "darwin" || process.arch !== "arm64")("requires a matching bounded native snapshot before publishing context time", async () => {
  const f = await fixture(), source = await resolveChatParentSource(f.home, f.parent, "read-only-source-v1")
  if (!("readOnlySource" in source)) throw Error("fixture")
  const snapshot = { terminalTurnId: randomUUID(), contextAt: 1000, sourceIdentity: source.readOnlySource.sourceIdentity, snapshotSha256: "a".repeat(64), endOrdinalExclusive: 3, endByteOffset: 4000, sourceFiles: 1, scannedBytes: 4000, contextBytes: 3000 }
  expect(validateSourceSnapshot(snapshot, source)).toEqual({ path: f.path, lastTurnId: snapshot.terminalTurnId, contextAt: 1000000 })
  for (const change of [{ sourceIdentity: "wrong" }, { sourceFiles: 9 }, { contextBytes: 17 * 1024 * 1024 }, { endByteOffset: -1 }, { terminalTurnId: "not-a-turn" }]) expect(() => validateSourceSnapshot({ ...snapshot, ...change }, source)).toThrow("SOURCE_BOUNDARY")
})
it("redacts unknown and decorated native errors", () => {
  expect(safeSourceError("SOURCE_CHANGED")).toBe("SOURCE_CHANGED")
  expect(safeSourceError("SOURCE_CHANGED /private/transcript")).toBeNull()
  expect(safeSourceError({ message: "SOURCE_CHANGED" })).toBeNull()
})
