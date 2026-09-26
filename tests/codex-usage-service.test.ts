import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CodexUsageService } from "../electron/main/codex-usage/CodexUsageService"
import type { UsageRead } from "../electron/main/codex-usage/CodexUsageReader"
const provider = { executablePath: "/fixture/codex", codexHome: "/fixture/home" }
const value = { fiveHour: { windowDurationMins: 300 as const, usedPercent: 24, resetsAtMs: 100000, freshness: "fresh" as const }, weekly: null, ordinaryUsageAllowed: false }
const success = (): UsageRead => ({ value, scope: "internal-scope" })
let services: CodexUsageService[] = []
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0) })
afterEach(async () => { await Promise.all(services.map(s => s.dispose())); services = []; vi.useRealTimers() })
const fixture = (read = vi.fn(async (): Promise<UsageRead> => success())) => { const s = new CodexUsageService(read, Date.now, () => .5); services.push(s); s.configure(true, provider); s.setVisible(true); return { s, read } }
describe("quota scheduling and generation", () => {
  it("single-flights manual/automatic reads and throttles manual refresh", async () => {
    const { s, read } = fixture()
    await Promise.all([s.refresh(), s.refresh(), s.refresh()]); expect(read).toHaveBeenCalledTimes(1)
    expect(s.snapshot()).toMatchObject({ state: "partial", ordinaryUsageAllowed: false })
    await s.refresh(); expect(read).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60000); expect(read).toHaveBeenCalledTimes(2)
  })
  it("does not poll hidden, disabled, suspended or disposed; resumes on stale entry", async () => {
    const { s, read } = fixture(); await s.refresh(); s.setVisible(false)
    await vi.advanceTimersByTimeAsync(300000); expect(read).toHaveBeenCalledTimes(1)
    s.setVisible(true); await vi.advanceTimersByTimeAsync(0); expect(read).toHaveBeenCalledTimes(2)
    s.setSuspended(true); await vi.advanceTimersByTimeAsync(300000); expect(read).toHaveBeenCalledTimes(2)
    s.setSuspended(false); await vi.advanceTimersByTimeAsync(0); expect(read).toHaveBeenCalledTimes(3)
    s.configure(false, provider); await vi.advanceTimersByTimeAsync(300000); expect(read).toHaveBeenCalledTimes(3); expect(s.snapshot().fiveHour).toBeNull()
  })
  it("rejects stale in-flight results after provider switch and waits for cleanup", async () => {
    let finish!: (r: UsageRead) => void
    const read = vi.fn().mockImplementationOnce(() => new Promise<UsageRead>(r => { finish = r })).mockResolvedValue(success())
    const { s } = fixture(read); const pending = s.refresh()
    const signal = read.mock.calls[0][1] as AbortSignal
    s.configure(true, { ...provider, codexHome: "/other" }); expect(signal.aborted).toBe(true)
    expect(s.snapshot().fiveHour).toBeNull(); const rev = s.snapshot().revision
    finish(success()); await pending; expect(s.snapshot().fiveHour).toBeNull()
    await vi.advanceTimersByTimeAsync(0); expect(read).toHaveBeenCalledTimes(2); expect(s.snapshot().revision).toBeGreaterThan(rev)
  })
  it("discards unproven account cache on failure/logout/API key and backs off", async () => {
    const { s, read } = fixture(); await s.refresh()
    read.mockResolvedValue({ reason: "query-failed" }); await vi.advanceTimersByTimeAsync(60000)
    expect(s.snapshot()).toMatchObject({ state: "unavailable", fiveHour: null, observedAtMs: null })
    await vi.advanceTimersByTimeAsync(60000); expect(read).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(119999); expect(read).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1); expect(read).toHaveBeenCalledTimes(4)
    for (const reason of ["not-signed-in", "api-key-account"] as const) { read.mockResolvedValue({ reason }); await vi.advanceTimersByTimeAsync(15000); await s.refresh(); expect(s.snapshot()).toMatchObject({ reason, fiveHour: null }) }
    expect(JSON.stringify(s.snapshot())).not.toMatch(/internal-scope|fixture|other/)
  })
  it("marks expired windows without zeroing them, then ages/discards on redisplay", async () => {
    const { s } = fixture(); await s.refresh(); s.setVisible(false)
    await vi.advanceTimersByTimeAsync(180000); s.setVisible(true)
    expect(s.snapshot()).toMatchObject({ state: "stale", fiveHour: { usedPercent: 24, freshness: "reset-pending" } })
    s.setVisible(false); await vi.advanceTimersByTimeAsync(420000); s.setVisible(true)
    expect(s.snapshot()).toMatchObject({ state: "unavailable", fiveHour: null })
  })
  it("does not discover or launch without a valid selected provider", async () => {
    const { s, read } = fixture(); s.configure(true, { codexHome: null, executablePath: null }); await s.refresh()
    expect(read).not.toHaveBeenCalled(); expect(s.snapshot().reason).toBe("cli-missing")
  })
})
