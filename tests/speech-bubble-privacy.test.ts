import { afterEach, describe, expect, it, vi } from "vitest"
import { createElement, createRef } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { CharacterDialogueController } from "../src/dialogue/CharacterDialogueController"
import { CharacterStateMachine } from "../src/behavior/CharacterStateMachine"
import { createDefaultBehaviorProfile } from "../src/behavior/BehaviorManifest"
import { ProtocolTaskEventSource } from "../src/protocol/ProtocolTaskEventSource"
import type { CharacterEventProtocolClient } from "../src/protocol/CharacterEventProtocolClient"
import type { ProtocolFrame } from "../src/protocol/types"
import { SpeechBubbleOverlay } from "../src/pet/SpeechBubbleOverlay"
import { dialogueProfile } from "./helpers/dialogue"

afterEach(() => vi.restoreAllMocks())
describe("speech bubble privacy boundary", () => {
  it("never renders or records raw protocol data, IDs or failure messages", () => {
    const secrets = ["SECRET_PROMPT", "rm -rf example", "/private/path", "API_KEY", "raw failure message"]
    const logs = [vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "log")]
    const c = new CharacterDialogueController({ random: () => 0 }); c.configure(dialogueProfile(), "bell")
    const machine = new CharacterStateMachine(createDefaultBehaviorProfile().timing, { now: () => 1 })
    let accepted: (frame: ProtocolFrame) => void = () => {}
    const source = new ProtocolTaskEventSource({ subscribeAccepted: (fn: typeof accepted) => { accepted = fn; return () => {} } } as CharacterEventProtocolClient, { now: () => 1 })
    source.subscribe((event) => machine.dispatch(event))
    source.subscribeLifecycle((event) => c.handleLifecycle(event, machine.getSnapshot()))
    const send = (payload: unknown) => accepted({ protocolVersion: 1, frameType: "event", sequence: 1, messageId: "m", source: "source", sourceInstanceId: "instance", sessionId: "PRIVATE_SESSION", sentAt: 0, payload } as ProtocolFrame)
    const rendered: string[] = []
    c.subscribe(() => rendered.push(renderToStaticMarkup(createElement(SpeechBubbleOverlay, { snapshot: c.getSnapshot(), runtime: {} as never, canvasRef: createRef<HTMLCanvasElement>() }))))
    send({ type: "run.started", runId: "PRIVATE_RUN", label: secrets.join(" ") })
    send({ type: "task.started", runId: "PRIVATE_RUN", taskId: "PRIVATE_TASK", kind: "command", label: secrets.join(" ") })
    send({ type: "run.failed", runId: "PRIVATE_RUN", code: "API_KEY", message: secrets.join(" ") })
    c.clear()
    send({ type: "run.started", runId: "PRIVATE_COMPLETED", label: secrets.join(" ") })
    send({ type: "run.completed", runId: "PRIVATE_COMPLETED", summary: secrets.join(" "), confidence: "observed" })
    const text = rendered.join() + JSON.stringify(c.getSnapshot())
    for (const secret of [...secrets, "PRIVATE_RUN", "PRIVATE_TASK", "PRIVATE_SESSION", "PRIVATE_COMPLETED"]) expect(text.includes(secret)).toBe(false)
    expect(text).toContain("확인할게.")
    for (const log of logs) expect(log).not.toHaveBeenCalled()
    source.dispose(); c.dispose()
  })
})
