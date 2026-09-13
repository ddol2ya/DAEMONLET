import { describe, expect, it, vi } from "vitest"
import { runOwnedProbe } from "../adapter/codex/app-server/AppServerOwnedProbe"

const mock = vi.hoisted(() => ({
  notify: null as null | ((method: string, params: unknown) => void),
  request: vi.fn<(method: string, params: unknown) => Promise<unknown>>(),
  stop: vi.fn(async () => {}),
  unsubscribe: vi.fn(),
}))

vi.mock("../adapter/codex/app-server/AppServerProcess.ts", () => ({
  AppServerProcess: class {
    stderrSummary = ""
    start = async () => ({
      initialize: async () => {},
      request: mock.request,
      onNotification: (listener: typeof mock.notify) => { mock.notify = listener; return mock.unsubscribe },
    })
    stop = mock.stop
  },
}))

describe("owned App Server probe", () => {
  it("waits for turn/started after an early turn/start acknowledgement before interrupting", async () => {
    mock.request.mockImplementation(async (method) => {
      if (method === "thread/start") return { thread: { id: "thread" } }
      if (method === "turn/start") return { turn: { id: "acknowledged-turn" } }
      if (method === "turn/interrupt") {
        mock.notify?.("turn/completed", { threadId: "thread", turn: { id: "started-turn", status: "interrupted", error: null } })
        return {}
      }
      throw new Error("Unexpected request")
    })
    const events: string[] = []
    const probe = runOwnedProbe("unused-codex", "test", 2000, true, { onProtocolEvent: event => events.push(event.type) })
    await vi.waitFor(() => expect(mock.request).toHaveBeenCalledWith("turn/start", expect.anything()))
    expect(mock.request.mock.calls.map(([method]) => method)).not.toContain("turn/interrupt")
    mock.notify?.("turn/started", { threadId: "thread", turn: { id: "started-turn", status: "inProgress" } })
    expect(await probe).toMatchObject({ status: "passed", scenario: "interrupted", finalSnapshot: [] })
    expect(mock.request).toHaveBeenLastCalledWith("turn/interrupt", { threadId: "thread", turnId: "started-turn" })
    expect(events).toEqual(["run.started", "run.cancelled"])
    expect(mock.unsubscribe).toHaveBeenCalledOnce()
    expect(mock.stop).toHaveBeenCalledOnce()
  })
})
