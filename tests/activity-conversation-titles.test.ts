import { afterEach, describe, expect, it, vi } from "vitest"
import { ActivityConversationTitles } from "../electron/main/activity/ActivityConversationTitles"

const instances: ActivityConversationTitles[] = []
afterEach(() => { instances.splice(0).forEach(value => value.dispose()); vi.useRealTimers() })
const a = { id: "a", title: "현재 세션 제목", cwd: "/project", path: "/tmp/home/sessions/a.jsonl", updatedAt: 1 }

describe("ephemeral activity conversation titles", () => {
  it("uses the same conversation's current title when its verified rollout has rotated", async () => {
    const id = "11111111-1111-4111-8111-111111111111"
    const old = `/tmp/home/sessions/2026/09/11/rollout-test-${id}.jsonl`
    const path = `/tmp/home/sessions/2026/09/12/rollout-test-${id}_22222222-2222-4222-8222-222222222222.jsonl`
    const publish = vi.fn(), value = new ActivityConversationTitles(async () => [{ ...a, id, path }], publish); instances.push(value)
    value.setTargets(new Map([["key", { threadId: id, rolloutPath: old }], ["other-home", { threadId: id, rolloutPath: old.replace("/tmp/home/", "/elsewhere/") }]]))
    await value.refresh()
    expect(publish.mock.lastCall?.[0]).toEqual(new Map([["key", a.title]]))
  })
  it("matches both the verified session ID and path, refreshes renames, and removes lost targets", async () => {
    vi.useFakeTimers()
    const read = vi.fn(async () => [a]), publish = vi.fn()
    const value = new ActivityConversationTitles(read, publish); instances.push(value)
    const targetPath = process.platform === "darwin" ? `/private${a.path}` : a.path
    value.setTargets(new Map([["key", { threadId: "a", rolloutPath: targetPath }], ["wrong-path", { threadId: "a", rolloutPath: "/other/a.jsonl" }]]))
    await value.refresh()
    expect(publish.mock.lastCall?.[0]).toEqual(new Map([["key", a.title]]))
    read.mockResolvedValue([{ ...a, title: "바꾼 제목" }]); await vi.advanceTimersByTimeAsync(5000)
    expect(publish.mock.lastCall?.[0]).toEqual(new Map([["key", "바꾼 제목"]]))
    value.setTargets(new Map())
    expect(publish.mock.lastCall?.[0]).toEqual(new Map())
    expect(vi.getTimerCount()).toBe(0)
  })

  it("ignores stale reads after a target change and stops publishing after disposal", async () => {
    let finish!: (rows: typeof a[]) => void
    const read = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve })).mockResolvedValue([{ ...a, id: "b", title: "B", path: "/b" }])
    const publish = vi.fn(), value = new ActivityConversationTitles(read, publish); instances.push(value)
    value.setTargets(new Map([["key", { threadId: "a", rolloutPath: a.path }]]))
    value.setTargets(new Map([["key", { threadId: "b", rolloutPath: "/b" }]]))
    finish([a]); await value.refresh()
    expect(publish.mock.calls.every(([titles]) => titles.get("key") !== a.title)).toBe(true)
    expect(publish.mock.lastCall?.[0]).toEqual(new Map([["key", "B"]]))
    value.dispose(); const count = publish.mock.calls.length
    await value.refresh(); value.setTargets(new Map())
    expect(publish).toHaveBeenCalledTimes(count)
  })
})
