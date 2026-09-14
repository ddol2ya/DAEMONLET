import { describe, expect, it, vi } from "vitest"
import { PassThrough } from "node:stream"
import { EventEmitter } from "node:events"
import { DictationService } from "../electron/main/control/DictationService"

function fakeProcess() {
  return Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn(() => true) })
}
describe("dictation lifecycle", () => {
  it("preserves split Korean UTF-8, keeps final text, and releases the native process", () => {
    const child = fakeProcess(), service = new DictationService("/bundled/helper", () => child as never, "darwin")
    service.start("session-A")
    const message = Buffer.from(JSON.stringify({ type: "partial", text: "작업 확인해줘" }) + "\n")
    const cut = message.indexOf(Buffer.from("작")) + 1
    child.stdout.write(message.subarray(0, cut)); child.stdout.write(message.subarray(cut))
    expect(service.snapshot().text).toBe("작업 확인해줘")
    child.stdout.write(JSON.stringify({ type: "final", text: "작업 확인해줘." }) + "\n")
    expect(service.snapshot()).toMatchObject({ state: "idle", text: "작업 확인해줘." })
    expect(child.kill).toHaveBeenCalledWith("SIGTERM")
    service.dispose()
  })
  it.each(["", "  "])("keeps the last recognized text when stopping produces an empty final result (%j)", text => {
    const child = fakeProcess(), service = new DictationService("/bundled/helper", () => child as never, "darwin")
    service.start("one")
    child.stdout.write(JSON.stringify({ type: "partial", text: "받아쓰기 확인 중입니다" }) + "\n")
    service.stop("one")
    child.stdout.write(JSON.stringify({ type: "partial", text }) + "\n")
    expect(service.snapshot()).toMatchObject({ state: "stopping", text: "받아쓰기 확인 중입니다" })
    child.stdout.write(JSON.stringify({ type: "final", text }) + "\n")
    expect(service.snapshot()).toMatchObject({ state: "idle", text: "받아쓰기 확인 중입니다", error: null })
    service.dispose()
  })
  it("accepts a final correction and never restores a previous session's text", () => {
    const first = fakeProcess(), second = fakeProcess()
    const launch = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second)
    const service = new DictationService("/bundled/helper", launch, "darwin")
    service.start("one")
    first.stdout.write(JSON.stringify({ type: "partial", text: "첫 번째" }) + "\n")
    service.stop("one")
    first.stdout.write(JSON.stringify({ type: "final", text: "첫 번째 문장입니다." }) + "\n")
    expect(service.snapshot().text).toBe("첫 번째 문장입니다.")
    service.start("two")
    second.stdout.write(JSON.stringify({ type: "final", text: "" }) + "\n")
    expect(service.snapshot()).toMatchObject({ sessionId: "two", state: "idle", text: "" })
    service.dispose()
  })
  it("does not send speech to Codex and ignores late output after cancellation", () => {
    const old = fakeProcess(), next = fakeProcess(), launch = vi.fn().mockReturnValueOnce(old).mockReturnValueOnce(next)
    const service = new DictationService("/bundled/helper", launch, "darwin")
    service.start("old"); service.cancel(); service.start("new")
    old.stdout.write(JSON.stringify({ type: "final", text: "must not replace the new draft" }) + "\n")
    expect(service.snapshot()).toMatchObject({ sessionId: "new", text: "" })
    expect(launch).toHaveBeenCalledWith("/bundled/helper", ["--dictate", "--locale", "ko-KR"])
    service.dispose(); expect(next.kill).toHaveBeenCalled()
  })
  it("stops only its recording, reports permission failure, and clears timers", () => {
    const child = fakeProcess(), service = new DictationService("/bundled/helper", () => child as never, "darwin")
    const input = vi.fn(); child.stdin.on("data", input)
    service.start("one"); service.stop("other"); expect(input).not.toHaveBeenCalled()
    service.stop("one"); expect(input.mock.calls[0][0].toString()).toBe("stop\n")
    child.stdout.write(JSON.stringify({ type: "error", code: "PERMISSION_DENIED", privateText: "private" }) + "\n")
    expect(service.snapshot()).toMatchObject({ state: "error", error: "PERMISSION_DENIED" })
    expect(JSON.stringify(service.snapshot())).not.toContain("private")
    service.dispose()
  })
  it("rejects malformed and oversized helper output without retaining it", () => {
    const child = fakeProcess(), service = new DictationService("/bundled/helper", () => child as never, "darwin")
    service.start("one"); child.stdout.write("x".repeat(70_000))
    expect(service.snapshot()).toMatchObject({ state: "error", error: "RECOGNITION_FAILED", text: "" })
    service.dispose()
  })
})

describe("selected dictation language", () => {
  it("changes locale only for the next recording and preserves the current transcript on stop", () => {
    let language: "ko" | "en" = "en"
    const english = fakeProcess(), korean = fakeProcess()
    const launch = vi.fn().mockReturnValueOnce(english).mockReturnValueOnce(korean)
    const service = new DictationService("/bundled/helper", launch, "darwin", () => language)
    service.start("english")
    expect(launch).toHaveBeenLastCalledWith("/bundled/helper", ["--dictate", "--locale", "en-US"])
    english.stdout.write(JSON.stringify({ type: "partial", text: "Keep this draft." }) + "\n")
    language = "ko"
    expect(english.kill).not.toHaveBeenCalled()
    expect(service.snapshot().text).toBe("Keep this draft.")
    service.stop("english")
    english.stdout.write(JSON.stringify({ type: "final", text: "" }) + "\n")
    expect(service.snapshot()).toMatchObject({ state: "idle", text: "Keep this draft." })
    service.start("korean")
    expect(launch).toHaveBeenLastCalledWith("/bundled/helper", ["--dictate", "--locale", "ko-KR"])
    expect(service.snapshot().text).toBe("")
    korean.stdout.write(JSON.stringify({ type: "final", text: "새 문장" }) + "\n")
    expect(service.snapshot()).toMatchObject({ state: "idle", text: "새 문장" })
    service.dispose()
  })
  it("keeps Windows dictation unavailable instead of reporting a false success", () => {
    const launch = vi.fn(), service = new DictationService("/unused", launch, "win32", () => "en")
    expect(() => service.start("one")).toThrow("UNAVAILABLE")
    expect(launch).not.toHaveBeenCalled(); service.dispose()
  })
})
