import { appendFile, chmod, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { CodexLifecycleObserver, type LocalConversationTarget } from "../adapter/codex/lifecycle/CodexLifecycleObserver"
import { CodexRunRegistry } from "../adapter/codex/CodexRunRegistry"
import { canonicalRunId } from "../adapter/codex/privacy/CanonicalId"
import type { NormalizedCodexEvent } from "../adapter/codex/types"

const roots: string[] = [], observers: CodexLifecycleObserver[] = []
afterEach(async () => { await Promise.all(observers.splice(0).map(o => o.stop())); await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))) })
const sessionId = "01a08ffc-46d8-77f0-92c6-3b15412ed955"
const a = "01a090a0-0000-7000-8000-000000000001", b = "01a090a0-0000-7000-8000-000000000002"
const now = Date.UTC(2026, 8, 11, 14)
const record = (type: string, turnId = b, fields = {}) => JSON.stringify({ timestamp: new Date(now).toISOString(), type: "event_msg", payload: { type, turn_id: turnId, ...fields } }) + "\n"
async function fixture(existing = "") {
  const root = await mkdtemp(join(tmpdir(), "lifecycle-observer-")); roots.push(root)
  const dir = join(root, "sessions/2026/09/11"); await mkdir(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, `rollout-2026-09-11T19-21-10-${sessionId}.jsonl`)
  const header = JSON.stringify({ type: "session_meta", payload: { id: sessionId, base_instructions: "PRIVATE_INSTRUCTIONS" } }) + "\n"
  await writeFile(path, header + existing, { mode: 0o600 })
  const events: NormalizedCodexEvent[] = [], targets: LocalConversationTarget[] = []
  let clock = now
  const observer = new CodexLifecycleObserver({ home: root, now: () => clock, onEvent: async e => { events.push(e) }, onTarget: t => targets.push(t) }); observers.push(observer)
  return { root, path, header, events, targets, observer, advance(ms: number) { clock += ms }, async observe() { observer.observe(sessionId, a); await observer.poll() }, async append(text: string) { await appendFile(path, text); await observer.poll() } }
}
const freshId = (at: number, suffix: string) => { const hex = at.toString(16).padStart(12, "0"); return `${hex.slice(0, 8)}-${hex.slice(8)}-7000-8000-${suffix.padStart(12, "0")}` }
async function newFile(root: string, id: string, content: string) {
  const path = join(root, "sessions/2026/09/11", `rollout-2026-09-11T14-00-00-${id}.jsonl`)
  await writeFile(path, JSON.stringify({ type: "session_meta", payload: { id, source: "vscode", thread_source: "agent_created_thread" } }) + "\n" + content, { mode: 0o600 })
  return path
}

describe("authenticated-session lifecycle fallback", () => {
  it("discovers two sessions created after startup without any Hook and keeps their ends independent", async () => {
    const f = await fixture(record("task_started", a)); f.observer.start(); await f.observer.poll()
    const one = freshId(now + 1, "1"), two = freshId(now + 2, "2")
    const p1 = await newFile(f.root, one, record("task_started", a)), p2 = await newFile(f.root, two, record("task_started", b))
    f.advance(1100); await f.observer.poll(); await f.observer.poll()
    expect(f.events.map(e => [e.type, e.sessionId])).toEqual(expect.arrayContaining([["run.started", one], ["run.started", two]]))
    expect(f.events).toHaveLength(2); expect(f.targets).toHaveLength(2)
    await appendFile(p1, record("turn_aborted", a, { reason: "interrupted" })); await f.observer.poll()
    expect(f.events.at(-1)).toMatchObject({ type: "run.cancelled", sessionId: one })
    await appendFile(p2, record("task_complete", b)); await f.observer.poll()
    expect(f.events.at(-1)).toMatchObject({ type: "run.completed", sessionId: two })
  })
  it("does not discover pre-existing IDs or replay inherited old turns inside a newly created file", async () => {
    const f = await fixture(record("task_started", a)); f.observer.start(); await f.observer.poll()
    const inherited = JSON.stringify({ timestamp: new Date(now - 1000).toISOString(), type: "event_msg", payload: { type: "task_started", turn_id: a } }) + "\n"
    const id = freshId(now + 1, "3")
    await newFile(f.root, id, inherited + record("task_started", b))
    f.advance(1100); await f.observer.poll(); await f.observer.poll()
    expect(f.events).toMatchObject([{ type: "run.started", sessionId: id, turnId: b }])
    await f.observer.poll(); expect(f.events).toHaveLength(1)
  })
  it("retries a newly discovered file whose first header write is still incomplete", async () => {
    const f = await fixture(); f.observer.start(); await f.observer.poll()
    const id = freshId(now + 1, "4"), path = await newFile(f.root, id, "")
    await writeFile(path, "{")
    f.advance(1100); await f.observer.poll(); expect(f.events).toEqual([])
    await newFile(f.root, id, record("task_started", b))
    f.advance(500); await f.observer.poll(); await f.observer.poll()
    expect(f.events).toMatchObject([{ type: "run.started", sessionId: id }])
  })
  it("does not promote internal subagent sessions to top-level activities", async () => {
    const f = await fixture(); f.observer.start(); await f.observer.poll()
    const id = freshId(now + 1, "5"), path = await newFile(f.root, id, "")
    await writeFile(path, JSON.stringify({ type: "session_meta", payload: { id, source: { subAgent: { thread_spawn: { parent_thread_id: sessionId } } } } }) + "\n" + record("task_started", b))
    f.advance(1100); await f.observer.poll(); await f.observer.poll()
    f.advance(1100); await f.observer.poll()
    expect(f.events).toEqual([]); expect(f.targets).toEqual([])
  })
  it("baselines existing bytes and detects a later restart even with no prompt or tool Hook", async () => {
    const f = await fixture(record("task_started", a) + record("task_complete", a))
    await f.observe()
    expect(f.events).toEqual([])
    expect(f.targets).toEqual([{ sessionId, turnId: a, path: await realpath(f.path) }])
    await f.append(record("task_started"))
    expect(f.events).toMatchObject([{ type: "run.started", sessionId, turnId: b }])
    await f.append(record("task_complete", b, { last_agent_message: "PRIVATE_RESPONSE" }))
    expect(f.events.at(-1)).toMatchObject({ type: "run.completed", confidence: "hook-stop" })
    expect(JSON.stringify(f.events)).not.toMatch(/PRIVATE|path|instructions|response/)
    expect(f.targets).toHaveLength(2)
  })
  it("frames split Unicode lines and skips oversized bodies without mistaking their text for events", async () => {
    const f = await fixture(); await f.observe()
    const text = record("task_started", b, { ignored: "한글🙂" })
    const bytes = Buffer.from(text), split = bytes.indexOf(Buffer.from("한")) + 1
    await appendFile(f.path, bytes.subarray(0, split)); await f.observer.poll(); expect(f.events).toEqual([])
    await appendFile(f.path, bytes.subarray(split)); await f.observer.poll()
    const privateBody = JSON.stringify({ type: "response_item", payload: { text: "SECRET".repeat(15000) + record("task_started", a) } })
    await f.append(privateBody + "\n" + record("turn_aborted", b, { reason: "interrupted" }))
    expect(f.events.map(e => e.type)).toEqual(["run.started", "run.cancelled"])
    expect(f.events.at(-1)).toMatchObject({ reason: "interrupted" })
  })
  it("ignores other schemas, invalid identity, future records and non-lifecycle text", async () => {
    const f = await fixture(); await f.observe()
    await f.append(record("agent_message", b) + record("task_started", "../../escape") + JSON.stringify({ timestamp: "2099-01-01T00:00:00Z", type: "event_msg", payload: { type: "task_started", turn_id: b } }) + "\n")
    expect(f.events).toEqual([])
    f.observer.observe("../../untrusted", a); await f.observer.poll()
    expect(f.targets).toHaveLength(1)
  })
  it.each(["symlink", "wrong-header"])("refuses %s targets without exposing them to navigation", async kind => {
    const f = await fixture()
    if (kind === "symlink") { await rename(f.path, f.path + ".original"); await symlink(f.path + ".original", f.path) }
    if (kind === "wrong-header") await writeFile(f.path, JSON.stringify({ type: "session_meta", payload: { id: b } }) + "\n")
    await f.observe(); await f.append(record("task_started"))
    expect(f.events).toEqual([]); expect(f.targets).toEqual([])
  })
  it.runIf(process.platform !== "win32")("refuses group/other-writable lifecycle files on POSIX", async () => {
    const f = await fixture()
    await chmod(f.path, 0o666)
    await f.observe(); await f.append(record("task_started"))
    expect(f.events).toEqual([]); expect(f.targets).toEqual([])
  })
  it("stops reading a replaced file and never replays its contents", async () => {
    const f = await fixture(); await f.observe()
    await rename(f.path, f.path + ".old"); await writeFile(f.path, f.header + record("task_started"), { mode: 0o600 })
    await f.observer.poll(); expect(f.events).toEqual([])
    await f.observer.stop(); await f.append(record("task_started")); expect(f.events).toEqual([])
  })
  it("skips a large output body without cancelling work and still observes its terminal record", async () => {
    const f = await fixture(); await f.observe()
    await f.append("x".repeat(2 * 1024 * 1024 + 1) + "\n" + record("task_complete", a))
    expect(f.events).toEqual([])
    for (let i = 0; i < 4; i++) await f.observer.poll()
    expect(f.events).toMatchObject([{ type: "run.completed", turnId: a }])
  })
  it("keeps an interrupted identity closed when its fallback start arrives late, while allowing the new turn", () => {
    const registry = new CodexRunRegistry(), emitted: string[] = []
    registry.subscribe(e => emitted.push(e.type))
    const common = { sessionId, turnId: a, backend: "HOOK_OBSERVER" as const, observedAt: now }
    registry.apply({ ...common, type: "run.cancelled", reason: "interrupted" })
    registry.apply({ ...common, type: "run.started" })
    expect(registry.getSnapshot()).toEqual([])
    registry.apply({ ...common, turnId: b, type: "run.started" })
    registry.apply({ ...common, turnId: b, type: "run.started" })
    expect(registry.getSnapshot().map(r => r.runId)).toEqual([canonicalRunId(sessionId, b)])
    expect(emitted).toEqual(["run.started"])
  })
})
