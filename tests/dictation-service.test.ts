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
  it("does not send speech to Codex and ignores late output after cancellation", () => {
    const old = fakeProcess(), next = fakeProcess(), launch = vi.fn().mockReturnValueOnce(old).mockReturnValueOnce(next)
    const service = new DictationService("/bundled/helper", launch, "darwin")
    service.start("old"); service.cancel(); service.start("new")
    old.stdout.write(JSON.stringify({ type: "final", text: "must not replace the new draft" }) + "\n")
    expect(service.snapshot()).toMatchObject({ sessionId: "new", text: "" })
    expect(launch).toHaveBeenCalledWith("/bundled/helper")
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
