import { EventEmitter } from "node:events"
import { expect, it, vi } from "vitest"
import type { AppUpdater } from "electron-updater"
vi.mock("electron", () => ({ app: {}, autoUpdater: new EventEmitter() }))
import { OfficialUpdateEngine } from "../electron/main/updates/OfficialUpdater"

class EmitterUpdater extends EventEmitter {
  quitAndInstall = vi.fn()
}
const fixture = () => {
  const updater = new EmitterUpdater()
  const engine = new OfficialUpdateEngine(updater as unknown as AppUpdater, "/unused-review-cache")
  return { updater, engine }
}
it("forwards a synchronous error event even when quitAndInstall returns void", () => {
  const { updater, engine } = fixture(), failed = vi.fn(), error = Error("dispatchError then false")
  updater.quitAndInstall.mockImplementation(() => { updater.emit("error", error) })
  const stop = engine.install(failed)
  expect(failed).toHaveBeenCalledExactlyOnceWith(error)
  stop()
})
it("owns asynchronous errors after native handoff returns until explicitly detached", async () => {
  const { updater, engine } = fixture(), failed = vi.fn(), error = Error("async spawn error")
  updater.quitAndInstall.mockImplementation(() => { queueMicrotask(() => updater.emit("error", error)) })
  const stop = engine.install(failed)
  await Promise.resolve()
  expect(failed).toHaveBeenCalledExactlyOnceWith(error)
  stop(); updater.emit("error", Error("after disposal"))
  expect(failed).toHaveBeenCalledOnce()
})
it("propagates throws and detaches their observer without claiming success", () => {
  const { updater, engine } = fixture(), failed = vi.fn()
  updater.quitAndInstall.mockImplementation(() => { throw Error("synchronous installer failure") })
  expect(() => engine.install(failed)).toThrow("synchronous installer failure")
  updater.emit("error", Error("late error"))
  expect(failed).not.toHaveBeenCalled()
  expect(() => engine.install(failed)).toThrow("INSTALL_ALREADY_STARTED")
})
it("keeps old updater emitters separate from the next engine attempt", () => {
  const former = fixture(), next = fixture(), oldFailure = vi.fn(), nextFailure = vi.fn()
  const stop = former.engine.install(oldFailure); stop()
  const stopNext = next.engine.install(nextFailure)
  former.updater.emit("error", Error("late previous engine"))
  expect(oldFailure).not.toHaveBeenCalled(); expect(nextFailure).not.toHaveBeenCalled()
  next.updater.emit("error", Error("current engine"))
  expect(nextFailure).toHaveBeenCalledOnce(); stopNext()
})
