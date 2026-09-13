import { describe, expect, it, vi } from "vitest"
import { createDefaultBehaviorProfile } from "../src/behavior/BehaviorManifest"
import { CharacterBehaviorController, type CharacterBehaviorRuntime } from "../src/behavior/CharacterBehaviorController"
import { CharacterStateMachine } from "../src/behavior/CharacterStateMachine"
import type { Anime25DParameterState } from "../src/engine/anime25d/types"
import type { PoseRuntimeDiagnostics } from "../src/pose/types"
import type { BehaviorAction } from "../src/behavior/types"
import { MockTaskEventSource } from "../src/behavior/MockTaskEventSource"

class FakeClock {
  constructor(public time = 0) {}
  now() { return this.time }
  advance(ms: number) { this.time += ms }
}

type Deferred = { promise: Promise<void>; resolve(): void; reject(error: Error): void }
const deferred = (): Deferred => {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

class MockRuntime implements CharacterBehaviorRuntime {
  loadCalls: string[] = []
  enterCalls: string[] = []
  exitCalls = 0
  cancelCalls = 0
  stateSource: Partial<Anime25DParameterState> = {}
  actionSource: Partial<Anime25DParameterState> = {}
  activePoseId: string | null = null
  loadGate: Deferred | null = null
  enterGate: Deferred | null = null
  abortGate: Deferred | null = null
  enterSignals: AbortSignal[] = []
  pose: Pick<PoseRuntimeDiagnostics, "id" | "loadStatus" | "state"> = { id: null, loadStatus: "unavailable", state: "BASE" }

  async loadPoseById(id: string) {
    this.loadCalls.push(id)
    this.pose = { id, loadStatus: "loading", state: "BASE" }
    if (this.loadGate) await this.loadGate.promise
    this.pose = { id, loadStatus: "ready", state: "BASE" }
  }
  async enterPose(id?: string, options?: { signal?: AbortSignal }) {
    const poseId = id ?? this.pose.id ?? "unknown"
    this.enterCalls.push(poseId)
    if (options?.signal) this.enterSignals.push(options.signal)
    if (this.enterGate) await Promise.race([
      this.enterGate.promise,
      new Promise<never>((_, reject) => options?.signal?.addEventListener("abort", () => {
        const error = new Error("aborted")
        error.name = "AbortError"
        if (this.abortGate) void this.abortGate.promise.then(() => reject(error))
        else reject(error)
      }, { once: true })),
    ])
    this.activePoseId = poseId
    this.pose = { ...this.pose, state: "ACTIVE_LOOP" }
  }
  exitPose() {
    this.exitCalls++
    this.activePoseId = null
    this.pose = { ...this.pose, state: "BASE" }
  }
  cancelPendingPoseLoad() { this.cancelCalls++ }
  getActivePoseId() { return this.activePoseId }
  getPoseDiagnostics() { return this.pose }
  setBehaviorStateParameters(values: Partial<Anime25DParameterState>) { this.stateSource = { ...values } }
  setBehaviorActionParameters(values: Partial<Anime25DParameterState>) { this.actionSource = { ...values } }
  clearBehaviorStateParameters() { this.stateSource = {} }
  clearBehaviorActionParameters() { this.actionSource = {} }
}

const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function selectedSetup() {
  const poses = ["writing", "waiting", "failed", "cancelled", "disconnected", "head-tap", "torso-tap"]
  const env = setup({ poses })
  const action = (id: string): BehaviorAction => ({ id: `${id}-reaction`, poseId: id, durationMs: 500, motion: { loopDurationMs: 500, parameters: { mouthOpen: { type: "constant", value: .2 } } } })
  env.profile.timing.boredAfterMs = 60_000
  env.profile.states.WAITING = { poseId: "waiting" }
  env.profile.disconnected = { poseId: "disconnected" }
  env.profile.failureReaction = action("failed")
  env.profile.cancellationReaction = action("cancelled")
  env.profile.interactionReactions = { HEAD_TAP: action("head-tap"), TORSO_TAP: action("torso-tap") }
  env.controller.configure(env.profile, poses)
  return env
}

function setup(options: { delayed?: boolean; delayedEnter?: boolean; poses?: string[]; actionDelay?: number } = {}) {
  const clock = new FakeClock()
  const profile = createDefaultBehaviorProfile()
  profile.timing = {
    ...profile.timing,
    boredAfterMs: 1_000,
    happyDurationMs: 80,
    stateBlendMs: 20,
    boredActionDelayMinMs: options.actionDelay ?? 10,
    boredActionDelayMaxMs: options.actionDelay ?? 10,
  }
  const runtime = new MockRuntime()
  if (options.delayed) runtime.loadGate = deferred()
  if (options.delayedEnter) runtime.enterGate = deferred()
  const machine = new CharacterStateMachine(profile.timing, clock)
  const controller = new CharacterBehaviorController(runtime, machine, profile, {
    clock,
    random: () => 0,
    availablePoseIds: options.poses ?? ["writing"],
  })
  return { clock, profile, runtime, machine, controller }
}

describe("behavior pose variants", () => {
  function variants() {
    const env = selectedSetup()
    const poses = ["writing", "waiting", "clasp", "wave", "bored", "yawn", "stretch", "happy", "v", "clap", "failed", "cancelled", "cross", "ease", "disconnected", "head-tap", "bunny", "salute", "torso-tap", "hug", "question"]
    env.profile.timing.boredAfterMs = 600_000
    env.profile.states.WAITING = { poseId: "waiting", poseVariants: ["clasp", "wave"], poseVariantIntervalMs: 5000 }
    env.profile.states.BORED = { poseId: "bored", poseVariants: ["yawn", "stretch"], poseVariantIntervalMs: 5000 }
    env.profile.states.HAPPY = { poseId: "happy", poseVariants: ["v", "clap"] }
    env.profile.cancellationReaction!.poseVariants = ["cross", "ease"]
    env.profile.interactionReactions!.HEAD_TAP!.poseVariants = ["bunny", "salute"]
    env.profile.interactionReactions!.TORSO_TAP!.poseVariants = ["hug", "question"]
    env.controller.configure(env.profile, poses)
    return { ...env, poses }
  }

  it.each(["HEAD_TAP", "TORSO_TAP"] as const)("cycles all three %s models with no adjacent repeats", async id => {
    const { controller, runtime, clock } = variants()
    const selected: Array<string | null> = []
    for (let i = 0; i < 9; i++) {
      clock.advance(850); controller.triggerInteraction(id); await flush()
      selected.push(runtime.activePoseId)
    }
    for (let i = 0; i < 9; i += 3) expect(new Set(selected.slice(i, i + 3)).size).toBe(3)
    expect(selected.every((pose, index) => index === 0 || pose !== selected[index - 1])).toBe(true)
    controller.dispose()
  })

  it("keeps a chosen reaction during cold loading and gives it its complete duration", async () => {
    const { controller, runtime, clock } = variants()
    runtime.enterGate = deferred()
    controller.triggerInteraction("HEAD_TAP"); await flush()
    const selected = controller.getDiagnostics().desiredPoseId
    clock.advance(10_000); controller.tick()
    expect(runtime.loadCalls).toEqual([selected])
    expect(controller.getDiagnostics().desiredPoseId).toBe(selected)
    runtime.enterGate.resolve(); await flush()
    clock.advance(499); controller.tick()
    expect(controller.getDiagnostics().currentReaction).toBe("head-tap-reaction")
    clock.advance(1); controller.tick()
    expect(controller.getDiagnostics().currentReaction).toBeNull()
    controller.dispose()
  })

  it("starts the waiting interval after entry and never advances a pending selection", async () => {
    const { controller, runtime, clock } = variants()
    controller.dispatch({ type: "TASK_STARTED", taskId: "work" }); await flush(); runtime.loadCalls.length = 0
    controller.dispatch({ type: "TASK_WAITING", taskId: "work" }); await flush()
    const first = runtime.activePoseId
    clock.advance(4999); controller.tick(); expect(runtime.loadCalls).toHaveLength(1)
    runtime.enterGate = deferred()
    clock.advance(1); controller.tick(); await flush()
    const second = controller.getDiagnostics().desiredPoseId
    expect(second).not.toBe(first)
    clock.advance(20_000); controller.tick(); expect(runtime.loadCalls).toHaveLength(2)
    runtime.enterGate.resolve(); runtime.enterGate = null; await flush()
    clock.advance(4999); controller.tick(); expect(runtime.loadCalls).toHaveLength(2)
    clock.advance(1); controller.tick(); await flush()
    expect(new Set(runtime.loadCalls).size).toBe(3)
    controller.dispose()
  })

  it("restores the selected waiting pose after a click and waits before rotating again", async () => {
    const { controller, runtime, clock } = variants()
    controller.dispatch({ type: "TASK_STARTED", taskId: "work" }); await flush(); runtime.loadCalls.length = 0
    controller.dispatch({ type: "TASK_WAITING", taskId: "work" }); await flush()
    const waiting = runtime.activePoseId
    clock.advance(4900); controller.triggerInteraction("TORSO_TAP"); await flush()
    clock.advance(300); controller.tick()
    expect(runtime.activePoseId).not.toBe(waiting)
    clock.advance(200); controller.tick(); await flush()
    expect(runtime.activePoseId).toBe(waiting)
    clock.advance(4999); controller.tick(); expect(runtime.activePoseId).toBe(waiting)
    clock.advance(1); controller.tick(); await flush(); expect(runtime.activePoseId).not.toBe(waiting)
    controller.dispose()
  })

  it("pauses rotation through a held pointer and manual mode, then follows task preemption", async () => {
    const { controller, runtime, clock } = variants()
    controller.dispatch({ type: "TASK_STARTED", taskId: "work" }); await flush(); runtime.loadCalls.length = 0
    controller.dispatch({ type: "TASK_WAITING", taskId: "work" }); await flush()
    controller.handlePointerGesture({ type: "begin", gestureId: 1 })
    clock.advance(6000); controller.tick(); expect(runtime.loadCalls).toHaveLength(1)
    controller.handlePointerGesture({ type: "end", gestureId: 1, reason: "released" })
    controller.tick(); await flush(); expect(runtime.loadCalls).toHaveLength(2)
    controller.setControlMode("MANUAL_POSE")
    clock.advance(6000); controller.tick(); expect(runtime.loadCalls).toHaveLength(2)
    controller.dispatch({ type: "TASK_RESUMED", taskId: "work" })
    controller.setControlMode("AUTO_BEHAVIOR"); await flush()
    expect(runtime.activePoseId).toBe("writing")
    controller.dispose()
  })

  it.each(["TASK_COMPLETED", "TASK_CANCELLED"] as const)("cycles distinct poses on repeated %s outcomes", async type => {
    const { controller, runtime, clock } = variants()
    const selected: Array<string | null> = []
    for (let i = 0; i < 6; i++) {
      clock.advance(1); controller.dispatch({ type: "TASK_STARTED", taskId: `work-${i}` }); await flush()
      controller.dispatch(type === "TASK_CANCELLED" ? { type, taskId: `work-${i}`, reason: "user-interrupted" } : { type, taskId: `work-${i}` }); await flush()
      selected.push(runtime.activePoseId)
    }
    expect(new Set(selected.slice(0, 3)).size).toBe(3)
    expect(new Set(selected.slice(3)).size).toBe(3)
    expect(selected.every((id, i) => i === 0 || id !== selected[i - 1])).toBe(true)
    controller.dispose()
  })

  it("filters unavailable alternatives and discards old choices on character configuration", async () => {
    const { controller, profile, runtime, clock } = variants()
    controller.configure(profile, ["head-tap", "salute"])
    for (let i = 0; i < 6; i++) { clock.advance(850); controller.triggerInteraction("HEAD_TAP"); await flush() }
    expect(new Set(runtime.loadCalls)).toEqual(new Set(["head-tap", "salute"]))
    profile.interactionReactions!.HEAD_TAP!.poseVariants = ["new-head"]
    controller.configure(profile, ["new-head"])
    controller.triggerInteraction("HEAD_TAP"); await flush()
    expect(runtime.activePoseId).toBe("new-head")
    controller.dispose()
  })
})

describe("CharacterBehaviorController", () => {
  it("coalesces rapid alternating taps until the visible reaction has settled", async () => {
    const { controller, runtime, clock, profile } = selectedSetup()
    profile.interactionReactions!.HEAD_TAP!.durationMs = 3000
    controller.triggerInteraction("HEAD_TAP"); await flush()
    const entered = runtime.enterCalls.length
    clock.advance(100); controller.triggerInteraction("TORSO_TAP")
    clock.advance(100); controller.triggerInteraction("HEAD_TAP")
    clock.advance(100); controller.triggerInteraction("TORSO_TAP")
    controller.tick(); await flush()
    expect(runtime.enterCalls).toHaveLength(entered)
    clock.advance(549); controller.tick(); await flush()
    expect(runtime.activePoseId).toBe("head-tap")
    clock.advance(1); controller.tick(); await flush()
    expect(runtime.activePoseId).toBe("torso-tap")
    expect(runtime.enterCalls).toHaveLength(entered + 1)
    controller.dispose()
  })

  it("holds cold tap requests and discards queued taps when work changes", async () => {
    const { controller, runtime, clock } = selectedSetup()
    runtime.loadGate = deferred()
    controller.triggerInteraction("HEAD_TAP"); await flush()
    clock.advance(3000); controller.triggerInteraction("TORSO_TAP"); controller.tick()
    expect(runtime.loadCalls).toEqual(["head-tap"])
    runtime.loadGate.resolve(); await flush()
    clock.advance(499); controller.tick(); await flush()
    expect(runtime.activePoseId).toBe("head-tap")
    controller.dispatch({type:"TASK_STARTED",taskId:"new-work"}); await flush()
    clock.advance(1000); controller.tick(); await flush()
    expect(runtime.activePoseId).toBe("writing")
    controller.dispose()
  })

  it("asks for a fresh gesture on repeated taps without exiting the current pose", async () => {
    const { controller, runtime, clock } = selectedSetup()
    const enter = vi.spyOn(runtime,"enterPose")
    controller.triggerInteraction("HEAD_TAP")
    await flush()
    const exits = runtime.exitCalls
    clock.advance(300)
    controller.triggerInteraction("HEAD_TAP")
    await flush()
    expect(enter).toHaveBeenLastCalledWith("head-tap",expect.objectContaining({restartMotion:true}))
    expect(runtime.exitCalls).toBe(exits)
    clock.advance(400);controller.tick()
    expect(controller.getDiagnostics().currentReaction).toBe("head-tap-reaction")
  })
  it("requests the next state and tap pose without an intervening Base exit", async () => {
    const { controller, runtime } = selectedSetup()
    controller.dispatch({ type: "TASK_STARTED", taskId: "direct" })
    await flush()
    const exits = runtime.exitCalls
    controller.dispatch({ type: "TASK_WAITING", taskId: "direct" })
    await flush()
    controller.triggerInteraction("HEAD_TAP")
    await flush()
    expect(runtime.enterCalls.slice(-3)).toEqual(["writing", "waiting", "head-tap"])
    expect(runtime.exitCalls).toBe(exits)
  })
  it("uses its local receipt clock after debug advancement or switching sources", () => {
    const { controller, clock } = setup()
    clock.advance(100_000)
    const source = new MockTaskEventSource()
    controller.connect(source)
    source.dispatch({ type: "TASK_STARTED", taskId: "external", at: 10 })
    source.dispatch({ type: "TASK_COMPLETED", taskId: "external", at: 20 })
    expect(controller.tick().state).toBe("HAPPY")
    expect(controller.getDiagnostics().semantic.stateSince).toBe(100_000)
    clock.advance(80)
    expect(controller.tick().state).toBe("NORMAL")
  })

  it("gives a cold click pose its complete hold time and returns to the current BUSY pose", async () => {
    const { controller, runtime, clock } = selectedSetup()
    controller.dispatch({ type: "TASK_STARTED", taskId: "A" })
    await flush()
    runtime.loadGate = deferred()
    controller.triggerInteraction("HEAD_TAP")
    await flush()
    clock.advance(3_000)
    controller.tick()
    expect(controller.getDiagnostics()).toMatchObject({ currentReaction: "head-tap-reaction", desiredPoseId: "head-tap" })
    runtime.loadGate.resolve()
    await flush()
    expect(runtime.activePoseId).toBe("head-tap")
    clock.advance(499)
    controller.tick()
    expect(controller.getDiagnostics().currentReaction).toBe("head-tap-reaction")
    clock.advance(1)
    controller.tick()
    await flush()
    expect(controller.getDiagnostics()).toMatchObject({ currentReaction: null, desiredPoseId: "writing", semantic: { state: "BUSY", activeTaskIds: ["A"] } })
    expect(runtime.activePoseId).toBe("writing")
  })

  it("prevents a pending click from activating after a new task or connection loss", async () => {
    const { controller, runtime } = selectedSetup()
    runtime.loadGate = deferred()
    controller.triggerInteraction("TORSO_TAP")
    controller.dispatch({ type: "TASK_STARTED", taskId: "A" })
    controller.dispatch({ type: "CONNECTION_CHANGED", connected: false })
    runtime.loadGate.resolve()
    await flush()
    expect(runtime.enterCalls).toEqual(["disconnected"])
    expect(controller.getDiagnostics()).toMatchObject({ connected: false, currentReaction: null, semantic: { state: "BUSY", activeTaskIds: ["A"], lastOutcome: null } })
    controller.dispatch({ type: "CONNECTION_CHANGED", connected: true })
    await flush()
    expect(runtime.activePoseId).toBe("writing")
  })

  it.each(["user-interrupted", "interrupted"])("plays a cancellation pose for %s once and leaves manual control alone", async (reason) => {
    const { controller, runtime, clock } = selectedSetup()
    controller.dispatch({ type: "TASK_STARTED", taskId: "A" })
    await flush()
    controller.dispatch({ type: "TASK_CANCELLED", taskId: "A", reason })
    await flush()
    expect(runtime.activePoseId).toBe("cancelled")
    expect(controller.getDiagnostics().semantic.state).toBe("NORMAL")
    clock.advance(500)
    controller.tick()
    expect(runtime.activePoseId).toBeNull()
    controller.setControlMode("MANUAL_POSE")
    const loads = [...runtime.loadCalls]
    controller.triggerInteraction("HEAD_TAP")
    expect(runtime.loadCalls).toEqual(loads)
    expect(controller.getDiagnostics().currentReaction).toBeNull()
  })

  it.each(["recovery-not-confirmed", "stale-adapter-state", "session-ended", undefined, "unknown"])("clears the final task without a user cancellation reaction for %s", async (reason) => {
    const { controller, runtime } = selectedSetup()
    controller.dispatch({ type: "TASK_STARTED", taskId: "A" })
    await flush()
    controller.dispatch({ type: "TASK_CANCELLED", taskId: "A", reason })
    await flush()
    expect(controller.getDiagnostics()).toMatchObject({
      currentReaction: null, desiredPoseId: null,
      semantic: { state: "NORMAL", activeTaskIds: [], lastEventAccepted: true, lastOutcome: { kind: "cancelled", taskId: "A", reason: reason ?? null } },
    })
    expect(runtime.activePoseId).toBeNull()
    expect(runtime.enterCalls).not.toContain("cancelled")
  })

  it.each([false, true])("preserves the remaining task after cleanup (waiting=%s)", async (waiting) => {
    const { controller, runtime } = selectedSetup()
    controller.dispatch({ type: "TASK_STARTED", taskId: "A" })
    if (waiting) controller.dispatch({ type: "TASK_WAITING", taskId: "A" })
    controller.dispatch({ type: "TASK_STARTED", taskId: "B" })
    await flush()
    controller.dispatch({ type: "TASK_CANCELLED", taskId: "B", reason: "recovery-not-confirmed" })
    await flush()
    expect(controller.getDiagnostics()).toMatchObject({
      currentReaction: null,
      semantic: { state: waiting ? "WAITING" : "BUSY", activeTaskIds: ["A"] },
    })
    expect(runtime.activePoseId).toBe(waiting ? "waiting" : "writing")
  })

  it("retains disconnection and restores snapshots without replaying an internal cancellation", async () => {
    const { controller, runtime } = selectedSetup()
    controller.dispatch({ type: "TASK_STARTED", taskId: "A" })
    controller.dispatch({ type: "CONNECTION_CHANGED", connected: false })
    await flush()
    controller.dispatch({ type: "TASK_CANCELLED", taskId: "A", reason: "session-ended" })
    await flush()
    expect(controller.getDiagnostics()).toMatchObject({ connected: false, currentReaction: null, desiredPoseId: "disconnected", semantic: { state: "NORMAL", activeTaskIds: [] } })
    controller.dispatch({ type: "TASK_SNAPSHOT", tasks: [{ taskId: "restored", waitingFor: "user-input" }] })
    controller.dispatch({ type: "CONNECTION_CHANGED", connected: true })
    await flush()
    expect(runtime.activePoseId).toBe("waiting")
    controller.dispatch({ type: "TASK_SNAPSHOT", tasks: [] })
    await flush()
    expect(controller.getDiagnostics()).toMatchObject({ currentReaction: null, desiredPoseId: null, semantic: { state: "NORMAL", activeTaskIds: [] } })
    expect(runtime.enterCalls).not.toContain("cancelled")
  })

  it("ends a failed pose request using the parameter fallback instead of holding forever", async () => {
    const { controller, runtime, clock } = selectedSetup()
    runtime.loadGate = deferred()
    controller.triggerInteraction("HEAD_TAP")
    runtime.loadGate.reject(new Error("missing PSD"))
    await flush()
    expect(controller.getDiagnostics().poseLoadStatus).toBe("fallback")
    clock.advance(500)
    controller.tick()
    expect(controller.getDiagnostics()).toMatchObject({ currentReaction: null, desiredPoseId: null })
  })

  it("applies BUSY fallback immediately and requests Writing", () => {
    const { controller, runtime } = setup({ delayed: true })
    controller.dispatch({ type: "TASK_STARTED", taskId: "A" })
    expect(runtime.loadCalls).toEqual(["writing"])
    expect(runtime.stateSource).toHaveProperty("eyeY")
    expect(controller.getDiagnostics()).toMatchObject({ poseLoadStatus: "loading", desiredPoseId: "writing" })
  })

  it("enters Writing only when the pose becomes ready while still BUSY", async () => {
    const { controller, runtime } = setup({ delayed: true })
    controller.dispatch({ type: "TASK_STARTED", taskId: "A" })
    runtime.loadGate?.resolve()
    await flush()
    expect(runtime.enterCalls).toEqual(["writing"])
    expect(controller.getDiagnostics().poseLoadStatus).toBe("ready")
  })

  it("does not enter a stale Writing result after fast completion", async () => {
    const { controller, runtime } = setup({ delayed: true })
    controller.dispatch({ type: "TASK_STARTED", taskId: "A" })
    controller.dispatch({ type: "TASK_COMPLETED", taskId: "A" })
    runtime.loadGate?.resolve()
    await flush()
    expect(controller.getDiagnostics().semantic.state).toBe("HAPPY")
    expect(runtime.enterCalls).toEqual([])
    expect(runtime.cancelCalls).toBeGreaterThan(0)
  })

  it("keeps BUSY fallback until the runtime reaches ACTIVE_LOOP", async () => {
    const { controller, runtime } = setup({ delayedEnter: true })
    controller.dispatch({ type: "TASK_STARTED", taskId: "A" })
    await flush()
    expect(controller.getDiagnostics().poseLoadStatus).toBe("entering")
    expect(runtime.stateSource).toHaveProperty("eyeY")
    runtime.enterGate?.resolve()
    await flush()
    expect(controller.getDiagnostics().poseLoadStatus).toBe("ready")
  })

  it("aborts an in-flight enter so a fast completion cannot activate Writing late", async () => {
    const { controller, runtime } = setup({ delayedEnter: true })
    controller.dispatch({ type: "TASK_STARTED", taskId: "A" })
    await flush()
    controller.dispatch({ type: "TASK_COMPLETED", taskId: "A" })
    runtime.enterGate?.resolve()
    await flush()
    expect(runtime.activePoseId).toBeNull()
    expect(controller.getDiagnostics().semantic.state).toBe("HAPPY")
  })

  it("keeps the latest enter controller when a stale abort settles late", async () => {
    const { controller, runtime } = setup({ delayedEnter: true })
    const staleAbort = deferred()
    runtime.abortGate = staleAbort
    controller.dispatch({ type: "TASK_STARTED", taskId: "A" })
    await flush()
    expect(runtime.enterSignals).toHaveLength(1)

    controller.dispatch({ type: "TASK_COMPLETED", taskId: "A" })
    controller.dispatch({ type: "TASK_STARTED", taskId: "B" })
    await flush()
    expect(runtime.enterSignals).toHaveLength(2)
    expect(controller.getDiagnostics()).toMatchObject({ poseLoadStatus: "entering", warning: null })

    staleAbort.resolve()
    await flush()
    expect(controller.getDiagnostics()).toMatchObject({ poseLoadStatus: "entering", warning: null })

    runtime.abortGate = null
    controller.dispatch({ type: "TASK_COMPLETED", taskId: "B" })
    expect(runtime.enterSignals[1].aborted).toBe(true)
    await flush()
    expect(controller.getDiagnostics().warning).toBeNull()
  })

  it("exits Writing for HAPPY and clears the state source after NORMAL blend", async () => {
    const { clock, controller, runtime } = setup()
    const initialExits = runtime.exitCalls
    controller.dispatch({ type: "TASK_STARTED", taskId: "A" })
    await flush()
    controller.dispatch({ type: "TASK_COMPLETED", taskId: "A" })
    expect(runtime.exitCalls).toBeGreaterThan(initialExits)
    clock.advance(80)
    controller.tick()
    clock.advance(20)
    controller.tick()
    expect(controller.getDiagnostics().semantic.state).toBe("NORMAL")
    expect(runtime.stateSource).toEqual({})
  })

  it("cancels a BORED action immediately on user activity", () => {
    const { clock, controller, runtime } = setup({ actionDelay: 0 })
    clock.advance(1_000)
    controller.tick()
    expect(controller.getDiagnostics().semantic.state).toBe("BORED")
    expect(controller.getDiagnostics().currentBoredAction).toBe("bored-look-away")
    expect(Object.keys(runtime.actionSource).length).toBeGreaterThan(0)
    controller.dispatch({ type: "USER_ACTIVITY", source: "pointer" })
    expect(controller.getDiagnostics().semantic.state).toBe("NORMAL")
    expect(controller.getDiagnostics().currentBoredAction).toBeNull()
    expect(runtime.actionSource).toEqual({})
  })

  it("does not duplicate a pending load for progress or duplicate starts", () => {
    const { controller, runtime } = setup({ delayed: true })
    controller.dispatch({ type: "TASK_STARTED", taskId: "A" })
    controller.dispatch({ type: "TASK_PROGRESS", taskId: "A", progress: 0.2 })
    controller.dispatch({ type: "TASK_STARTED", taskId: "A" })
    expect(runtime.loadCalls).toEqual(["writing"])
  })

  it("keeps automatic pose ownership disabled in MANUAL_POSE and resynchronizes on return", async () => {
    const { controller, runtime } = setup()
    controller.setControlMode("MANUAL_POSE")
    controller.dispatch({ type: "TASK_STARTED", taskId: "A" })
    expect(runtime.loadCalls).toEqual([])
    controller.setControlMode("AUTO_BEHAVIOR")
    await flush()
    expect(runtime.loadCalls).toEqual(["writing"])
    expect(runtime.enterCalls).toEqual(["writing"])
  })

  it("uses fallback with a diagnostic warning when Writing is unavailable", () => {
    const { controller, runtime } = setup({ poses: [] })
    controller.dispatch({ type: "TASK_STARTED", taskId: "A" })
    expect(runtime.loadCalls).toEqual([])
    expect(controller.getDiagnostics()).toMatchObject({ poseLoadStatus: "fallback" })
    expect(controller.getDiagnostics().warning).toMatch(/unavailable/)
  })

  it("applies a transient failure action and cancels it when a new task starts", () => {
    const { controller, runtime } = setup()
    controller.dispatch({ type: "TASK_STARTED", taskId: "A" })
    controller.dispatch({ type: "TASK_FAILED", taskId: "A" })
    expect(Object.keys(runtime.actionSource).length).toBeGreaterThan(0)
    controller.dispatch({ type: "TASK_STARTED", taskId: "B" })
    expect(runtime.actionSource).toEqual({})
  })

  it("preserves semantic Run state while model assets and behavior profile change", () => {
    const { controller, machine, profile } = setup({ delayed: true })
    controller.dispatch({ type: "TASK_STARTED", taskId: "external-run" })
    controller.prepareForModelChange()
    expect(machine.getSnapshot()).toMatchObject({ state: "BUSY", activeTaskIds: ["external-run"] })
    controller.configure(profile, ["writing"], false)
    expect(controller.getDiagnostics().semantic).toMatchObject({ state: "BUSY", activeTaskIds: ["external-run"] })
  })

  it("dispose invalidates pending work and clears behavior sources", async () => {
    const { controller, runtime } = setup({ delayed: true })
    const listener = vi.fn()
    controller.subscribe(listener)
    controller.dispatch({ type: "TASK_STARTED", taskId: "A" })
    controller.dispose()
    runtime.loadGate?.resolve()
    await flush()
    expect(runtime.enterCalls).toEqual([])
    expect(runtime.stateSource).toEqual({})
    expect(runtime.actionSource).toEqual({})
  })
})

describe("continuous local input reactions", () => {
  const prepare = () => {
    const env = selectedSetup()
    env.profile.continuousReactions = {
      PET: { poseId: 'head-pet', enterMs: 0, releaseMs: 200, workScale: .5, motion: { loopDurationMs: 2400, parameters: { eyeOpenL: { type:'constant', value:.6 }, mouthForm:{ type:'constant', value:.22 } } } },
      HOLD: { enterMs: 0, releaseMs: 200, workScale: .5, motion: { loopDurationMs: 2800, parameters: { eyeOpenL: { type:'constant', value:.72 }, mouthOpen:{ type:'constant', value:.2 } } } },
    }
    env.controller.configure(env.profile, ['writing','waiting','failed','cancelled','disconnected','head-tap','torso-tap','head-pet'])
    const begin = (gestureId=1, interactionId:'PET'|'HOLD'='PET') => {
      env.controller.dispatch({type:'USER_ACTIVITY',source:'pointer'})
      env.controller.handlePointerGesture({type:'begin',gestureId})
      expect(env.controller.handlePointerGesture({type:'continuous',phase:'start',gestureId,interactionId})).toBe(true)
    }
    return {...env,begin}
  }

  it("keeps petting during an unchanged background snapshot but releases it for new work", async () => {
    const { controller, begin } = prepare()
    controller.dispatch({type:"TASK_STARTED",taskId:"working"})
    begin(); await flush()
    controller.dispatch({type:"TASK_SNAPSHOT",tasks:[{taskId:"working"}]})
    expect(controller.getContinuousInteraction()?.phase).toBe("active")
    controller.dispatch({type:"TASK_SNAPSHOT",tasks:[{taskId:"working"},{taskId:"new"}]})
    expect(controller.getContinuousInteraction()).toBeNull()
    controller.dispose()
  })

  it.each([
    ['NORMAL', 'HEAD_TAP', 'HOLD', null],
    ['NORMAL', 'TORSO_TAP', 'HOLD', null],
    ['BUSY', 'HEAD_TAP', 'HOLD', 'writing'],
    ['BUSY', 'TORSO_TAP', 'HOLD', 'writing'],
    ['WAITING', 'HEAD_TAP', 'HOLD', 'waiting'],
    ['WAITING', 'TORSO_TAP', 'HOLD', 'waiting'],
    ['BUSY', 'HEAD_TAP', 'PET', 'writing'],
    ['BUSY', 'TORSO_TAP', 'PET', 'writing'],
    ['WAITING', 'HEAD_TAP', 'PET', 'waiting'],
    ['WAITING', 'TORSO_TAP', 'PET', 'waiting'],
  ] as const)('restores the %s pose when %s is replaced by continuous %s', async (state, tap, interactionId, expected) => {
    const { controller, runtime, clock, begin } = prepare()
    if (state !== 'NORMAL') controller.dispatch({ type: 'TASK_STARTED', taskId: 'work' })
    if (state === 'WAITING') controller.dispatch({ type: 'TASK_WAITING', taskId: 'work' })
    await flush()
    controller.triggerInteraction(tap)
    await flush()
    expect(runtime.activePoseId).toBe(tap === 'HEAD_TAP' ? 'head-tap' : 'torso-tap')

    clock.advance(480)
    controller.tick()
    begin(1, interactionId)
    await flush()
    // The session receives this callback after the continuous reaction takes over.
    controller.cancelInteractionReaction()
    const takeoverPose = runtime.activePoseId
    const loads = [...runtime.loadCalls], enters = [...runtime.enterCalls], exits = runtime.exitCalls
    for (let i = 0; i < 10; i++) controller.handlePointerGesture({ type: 'continuous', gestureId: 1, interactionId, phase: 'loop' })
    clock.advance(600)
    controller.tick()
    expect(takeoverPose).toBe(interactionId === 'PET' ? 'head-pet' : expected)
    expect(runtime.loadCalls).toEqual(loads)
    expect(runtime.enterCalls).toEqual(enters)
    expect(runtime.exitCalls).toBe(exits)
    controller.handlePointerGesture({ type: 'end', gestureId: 1, reason: 'released' })
    clock.advance(1000)
    controller.tick()
    await flush()

    expect(controller.getContinuousInteraction()).toBeNull()
    expect(controller.getDiagnostics()).toMatchObject({ currentReaction: null, desiredPoseId: expected, activePoseId: expected })
    expect(controller.machine.getSnapshot()).toMatchObject({ state, activeTaskIds: state === 'NORMAL' ? [] : ['work'], lastOutcome: null })
  })

  it.each([
    ['NORMAL', 'load'], ['BUSY', 'load'],
    ['NORMAL', 'transition'], ['BUSY', 'transition'],
  ] as const)('invalidates a pending tap %s/%s when a face hold takes over', async (state, phase) => {
    const { controller, runtime, clock, begin } = prepare()
    if (state === 'BUSY') controller.dispatch({ type: 'TASK_STARTED', taskId: 'work' })
    await flush()
    const gate = deferred()
    let tapSignal: AbortSignal | undefined
    if (phase === 'load') runtime.loadGate = gate
    else {
      const transitionToPose: NonNullable<CharacterBehaviorRuntime['transitionToPose']> = async (id, options) => {
        if (id === 'head-tap') {
          tapSignal = options?.signal
          await gate.promise
        }
        options?.signal?.throwIfAborted()
        await runtime.loadPoseById(id)
        await runtime.enterPose(id, options)
      }
      Object.assign(runtime, { transitionToPose })
    }
    controller.triggerInteraction('HEAD_TAP')
    await flush()
    expect(controller.getDiagnostics().poseLoadStatus).toBe('loading')
    runtime.loadGate = null
    clock.advance(480)
    begin(1, 'HOLD')
    await flush()
    controller.cancelInteractionReaction()
    controller.handlePointerGesture({ type: 'end', gestureId: 1, reason: 'released' })
    clock.advance(1000)
    controller.tick()
    gate.resolve()
    await flush()

    if (phase === 'transition') expect(tapSignal?.aborted).toBe(true)
    expect(runtime.enterCalls).not.toContain('head-tap')
    expect(controller.getContinuousInteraction()).toBeNull()
    const expected = state === 'BUSY' ? 'writing' : null
    expect(controller.getDiagnostics()).toMatchObject({
      currentReaction: null, desiredPoseId: expected, activePoseId: expected,
      poseLoadStatus: state === 'BUSY' ? 'ready' : 'idle', warning: null,
    })
  })

  it('replaces a tap with the dedicated idle pet pose and returns to Base on release', async () => {
    const { controller, runtime, clock, begin } = prepare()
    controller.triggerInteraction('HEAD_TAP')
    await flush()
    clock.advance(480)
    begin()
    await flush()
    controller.cancelInteractionReaction()
    expect(runtime.activePoseId).toBe('head-pet')
    controller.handlePointerGesture({ type: 'end', gestureId: 1, reason: 'released' })
    clock.advance(1000)
    controller.tick()
    await flush()
    expect(runtime.activePoseId).toBeNull()
    expect(controller.getContinuousInteraction()).toBeNull()
    expect(runtime.loadCalls.filter(id => id === 'head-pet')).toHaveLength(1)
  })

  it('holds a single loaded pet pose through repeated loops, stillness and idle ticks, then returns to the current state', async () => {
    const {controller, runtime, clock, begin} = prepare()
    const events: string[]=[]
    controller.subscribeLifecycle(event=>{if(event.type==='continuous.changed')events.push(event.phase)})
    begin();await flush()
    expect(runtime.activePoseId).toBe('head-pet')
    for(let i=0;i<40;i++) controller.handlePointerGesture({type:'continuous',gestureId:1,interactionId:'PET',phase:'loop'})
    clock.advance(65000);controller.tick()
    expect(runtime.activePoseId).toBe('head-pet')
    expect(runtime.loadCalls.filter(id=>id==='head-pet')).toHaveLength(1)
    expect(events).toEqual(['pending','active'])
    controller.dispatch({type:'USER_ACTIVITY',source:'pointer'})
    controller.handlePointerGesture({type:'end',gestureId:1,reason:'released'})
    expect(controller.machine.getSnapshot().state).toBe('NORMAL')
    expect(runtime.activePoseId).toBeNull()
    clock.advance(201);controller.tick()
    expect(runtime.actionSource).toEqual({})
    expect(controller.getContinuousInteraction()).toBeNull()
    expect(events).toEqual(['pending','active','ended'])
  })

  it.each(['BUSY','WAITING'] as const)('keeps %s arms and props for a reaction without a dedicated pose', async state => {
    const {controller,runtime,clock,begin}=prepare()
    controller.dispatch({type:'TASK_STARTED',taskId:'work'})
    if(state==='WAITING')controller.dispatch({type:'TASK_WAITING',taskId:'work'})
    await flush()
    const pose=runtime.activePoseId
    const loads=[...runtime.loadCalls],enters=[...runtime.enterCalls],exits=runtime.exitCalls
    for(const [gestureId,id] of [[1,'HOLD'],[2,'HOLD']] as const){
      begin(gestureId,id);clock.advance(50);controller.tick()
      await flush()
      expect(runtime.activePoseId).toBe(pose)
      expect(runtime.loadCalls).not.toContain('head-pet')
      expect(runtime.actionSource).toHaveProperty('eyeOpenL')
      expect(runtime.actionSource).not.toHaveProperty('body')
      controller.handlePointerGesture({type:'end',gestureId,reason:'pointer-cancel'})
      expect(runtime.actionSource).toEqual({})
      expect(runtime.loadCalls).toEqual(loads)
      expect(runtime.enterCalls).toEqual(enters)
      expect(runtime.exitCalls).toBe(exits)
    }
  })

  it.each(['BUSY', 'WAITING'] as const)('shows the pet pose during %s and returns to the same work without a synthetic task transition', async state => {
    const { controller, runtime, clock, begin } = prepare()
    controller.dispatch({ type: 'TASK_STARTED', taskId: 'work' })
    if (state === 'WAITING') controller.dispatch({ type: 'TASK_WAITING', taskId: 'work' })
    await flush()
    const semantic = controller.machine.getSnapshot(), workPose = runtime.activePoseId
    const lifecycle: string[] = []
    controller.subscribeLifecycle(event => { if (event.type === 'continuous.changed') lifecycle.push(event.phase) })
    const gate = deferred(); runtime.loadGate = gate
    begin()
    expect(runtime.activePoseId).toBe(workPose)
    expect(lifecycle).toEqual(['pending'])
    runtime.loadGate = null; gate.resolve(); await flush()
    expect(controller.getContinuousInteraction()?.phase).toBe('active')
    expect(runtime.activePoseId).toBe('head-pet')
    expect(lifecycle).toEqual(['pending', 'active'])
    expect(controller.machine.getSnapshot().activeTaskIds).toEqual(semantic.activeTaskIds)
    expect(controller.machine.getSnapshot().state).toBe(state)
    controller.handlePointerGesture({ type: 'end', gestureId: 1, reason: 'released' })
    clock.advance(250); controller.tick(); await flush()
    expect(runtime.activePoseId).toBe(workPose)
    expect(controller.getContinuousInteraction()).toBeNull()
    expect(controller.machine.getSnapshot()).toMatchObject({ state, activeTaskIds: ['work'], lastOutcome: null })
    expect(lifecycle).toEqual(['pending', 'active', 'ended'])
  })

  it('lets accepted work changes preempt the gesture and ignores loops/restarts until a new press', async () => {
    const {controller,runtime,begin}=prepare()
    begin();await flush()
    controller.dispatch({type:'TASK_STARTED',taskId:'work'});await flush()
    expect(runtime.activePoseId).toBe('writing')
    for(const phase of ['loop','start'] as const)controller.handlePointerGesture({type:'continuous',gestureId:1,interactionId:'PET',phase})
    expect(controller.getContinuousInteraction()).toBeNull()
    controller.handlePointerGesture({type:'end',gestureId:1,reason:'released'})
    begin(2,'HOLD')
    expect(controller.getContinuousInteraction()?.interactionId).toBe('HOLD')
    controller.dispatch({type:'TASK_STARTED',taskId:'parallel'})
    expect(controller.getContinuousInteraction()).toBeNull()
    expect(controller.machine.getSnapshot().activeTaskIds).toEqual(['parallel','work'])
  })

  it.each(['TASK_WAITING','TASK_RESUMED','TASK_COMPLETED','TASK_FAILED','TASK_CANCELLED'] as const)('preempts on accepted %s without changing run/outcome semantics', async type => {
    const {controller,begin}=prepare()
    controller.dispatch({type:'TASK_STARTED',taskId:'work'})
    if(type==='TASK_RESUMED')controller.dispatch({type:'TASK_WAITING',taskId:'work'})
    await flush();begin(1,'HOLD')
    controller.dispatch(type==='TASK_CANCELLED'?{type,taskId:'work',reason:'user-interrupted'}:{type,taskId:'work'})
    expect(controller.getContinuousInteraction()).toBeNull()
    const snapshot=controller.machine.getSnapshot()
    expect(snapshot.lastEventAccepted).toBe(true)
    controller.handlePointerGesture({type:'continuous',gestureId:1,interactionId:'HOLD',phase:'loop'})
    expect(controller.machine.getSnapshot()).toEqual(snapshot)
  })

  it.each(['happy','failure','cancelled','disconnected','manual'] as const)('does not cover the %s presentation', async state => {
    const {controller,runtime,begin}=prepare()
    if(state==='manual')controller.setControlMode('MANUAL_POSE')
    else if(state==='disconnected')controller.dispatch({type:'CONNECTION_CHANGED',connected:false})
    else {
      controller.dispatch({type:'TASK_STARTED',taskId:'work'})
      controller.dispatch(state==='happy'?{type:'TASK_COMPLETED',taskId:'work'}:state==='failure'?{type:'TASK_FAILED',taskId:'work'}:{type:'TASK_CANCELLED',taskId:'work',reason:'interrupted'})
    }
    await flush();const previous=runtime.activePoseId
    begin()
    expect(controller.getContinuousInteraction()).toBeNull()
    expect(runtime.activePoseId).toBe(previous)
  })

  it.each(['released','lost-pointer-capture','model-change','new-work'] as const)('rejects a late pet load after %s', async reason=>{
    const {controller,runtime,begin}=prepare();const gate=deferred();runtime.loadGate=gate
    const events:string[]=[];controller.subscribeLifecycle(e=>{if(e.type==='continuous.changed')events.push(e.phase)})
    begin()
    if(reason==='new-work')controller.dispatch({type:'TASK_STARTED',taskId:'work'})
    else if(reason==='model-change')controller.prepareForModelChange()
    else controller.handlePointerGesture({type:'end',gestureId:1,reason})
    gate.resolve();await flush()
    expect(runtime.enterCalls).not.toContain('head-pet')
    expect(events).toEqual(['pending','ended'])
  })

  it('preserves the current pose on asset failure and never retries from a loop', async()=>{
    const {controller,runtime,begin}=prepare();const gate=deferred();runtime.loadGate=gate
    begin();gate.reject(new Error('missing asset'));await flush()
    expect(runtime.activePoseId).toBeNull()
    expect(controller.getContinuousInteraction()).toBeNull()
    controller.handlePointerGesture({type:'continuous',gestureId:1,interactionId:'PET',phase:'loop'})
    expect(runtime.loadCalls.filter(id=>id==='head-pet')).toHaveLength(1)
  })
})
