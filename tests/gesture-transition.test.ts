import { describe, expect, it } from "vitest"
import { Anime25DRuntime } from "../src/engine/anime25d/Anime25DRuntime"
import { ParameterMixer } from "../src/interaction/ParameterMixer"
import { GestureRecognizer } from "../src/interaction/GestureRecognizer"

describe("gesture lifecycle invariants", () => {
  it("keeps a hold through small movement and closes it on pointerup", () => {
    const gesture = new GestureRecognizer()
    gesture.start(0, 0, 0, "face")
    expect(gesture.update(480).map((event) => event.type)).toEqual(["hold-start"])
    expect(gesture.move(5, 0, 500).map((event) => event.type)).toEqual(["hold-loop"])
    expect(gesture.end(5, 0, 520).map((event) => event.type)).toEqual(["hold-end"])
  })

  it("forces an infinite interaction to IDLE during model replacement", () => {
    const runtime = Object.create(Anime25DRuntime.prototype) as any
    runtime.mixer = new ParameterMixer()
    runtime.mixer.setSource("interaction", { eyeOpenL: .5 }, 40)
    runtime.interaction = { id: "HOLD_LOOP", startedAt: 0, duration: Number.POSITIVE_INFINITY }
    runtime.diagnostics = { interactionState: "HOLD_LOOP", gesture: "hold-loop" }
    runtime.cancelInteraction("model-change")
    expect(runtime.interaction).toBeNull()
    expect(runtime.diagnostics).toMatchObject({ interactionState: "IDLE", gesture: "model-change" })
  })
})
