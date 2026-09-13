import { describe, expect, it, vi } from "vitest"
import { MotionLifecycleBus } from "../src/motion/orchestration/MotionLifecycleBus"
import { MotionSourceHost } from "../src/motion/orchestration/MotionSourceHost"
import { InteractionMotionController } from "../src/motion/sources/InteractionMotionController"
import { ParameterMixer } from "../src/interaction/ParameterMixer"
import { Anime25DRuntime } from "../src/engine/anime25d/Anime25DRuntime"
import { PoseTransition } from "../src/pose/PoseTransition"

describe("MotionLifecycleBus", () => {
  it("keeps bounded history and unsubscribes without leaks", () => {
    const bus = new MotionLifecycleBus(2)
    const listener = vi.fn()
    const unsubscribe = bus.subscribe(listener)
    bus.emit({ type: "interaction.started", interactionId: "HOLD", at: 1 })
    unsubscribe()
    bus.emit({ type: "interaction.completed", interactionId: "HOLD", at: 2 })
    bus.emit({ type: "interaction.started", interactionId: "PET", at: 3 })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(bus.getHistory().map((entry) => entry.sequence)).toEqual([2, 3])
  })

  it("emits interaction lifecycle once and releases the source", () => {
    const mixer = new ParameterMixer()
    const host = new MotionSourceHost(mixer)
    const bus = new MotionLifecycleBus()
    const controller = new InteractionMotionController(host, bus, "interaction-owner")
    controller.start("HEAD_TAP", 0)
    controller.update(100)
    controller.update(680)
    controller.update(800)
    expect(bus.getHistory().map((entry) => entry.event.type)).toEqual(["interaction.started", "interaction.completed"])
    expect(host.diagnostics().at(-1)?.status).toBe("released")
  })

  it("cancels a persistent interaction exactly once", () => {
    const host = new MotionSourceHost(new ParameterMixer())
    const bus = new MotionLifecycleBus()
    const controller = new InteractionMotionController(host, bus, "interaction-owner")
    controller.start("PET_START", 0)
    controller.start("PET_LOOP", 10)
    controller.cancel("pointer-cancel", 20)
    controller.cancel("model-change", 30)
    expect(bus.getHistory().map((entry) => entry.event.type)).toEqual(["interaction.started", "interaction.cancelled"])
  })
})

function poseRuntime() {
  const runtime = Object.create(Anime25DRuntime.prototype) as any
  runtime.clock = { time: 0, now() { return this.time } }
  runtime.lifecycle = new MotionLifecycleBus()
  runtime.poseTransition = new PoseTransition({ enterMs: 100, exitMs: 80, swapStart: 0.3, swapEnd: 0.7 })
  runtime.poseAsset = { manifest: { id: "writing" } }
  runtime.poseDiagnostics = { id: "writing", loadStatus: "ready", state: "BASE", error: null }
  runtime.activePoseRequest = null
  runtime.poseWaiters = new Set()
  runtime.poseRequestSequence = 0
  runtime.lastPoseState = "BASE"
  runtime.renderer = {
    setPoseMix: vi.fn(),
    setPoseLayerTransforms: vi.fn(),
    baseResourceCount: 0,
    poseResourceCount: 0,
    meshCount: 0,
    textureCount: 0,
  }
  runtime.poseRegistry = { list: () => [] }
  runtime.baseHitResolver = null
  runtime.poseParameterLease = null
  runtime.diagnostics = null
  return runtime
}

describe("Anime25DRuntime pose lifecycle", () => {
  it("replays an active gesture only when requested, preserving the loaded pose", async () => {
    const runtime = poseRuntime()
    runtime.poseTransition.pauseAt(1)
    runtime.poseDiagnostics.state = "ACTIVE_LOOP"
    runtime.poseLoopStartedAt = 100
    runtime.poseMotionPlayback = { restart: vi.fn() }
    runtime.clock.time = 800
    const asset = runtime.poseAsset
    await runtime.enterPose("writing")
    expect(runtime.poseLoopStartedAt).toBe(100)
    expect(runtime.poseMotionPlayback.restart).not.toHaveBeenCalled()
    await runtime.enterPose("writing", { restartMotion: true })
    expect(runtime.poseLoopStartedAt).toBe(800)
    expect(runtime.poseMotionPlayback.restart).toHaveBeenCalledExactlyOnceWith(800)
    expect(runtime.poseAsset).toBe(asset)
    expect(runtime.poseTransition.sample(800).state).toBe("ACTIVE_LOOP")
    expect(runtime.renderer.setPoseMix).not.toHaveBeenCalled()
    expect(runtime.lifecycle.getHistory()).toEqual([])
  })

  it("completes enter only after ACTIVE_LOOP and emits each event once", async () => {
    const runtime = poseRuntime()
    let settled = false
    const entered = runtime.enterPose("writing").then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(runtime.lifecycle.getHistory().map((entry: any) => entry.event.type)).toEqual(["pose.enter.started"])
    runtime.clock.time = 100
    const sample = runtime.poseTransition.sample(100)
    runtime.updatePoseLifecycle(sample, 100)
    await entered
    runtime.updatePoseLifecycle(sample, 101)
    expect(runtime.lifecycle.getHistory().map((entry: any) => entry.event.type)).toEqual(["pose.enter.started", "pose.enter.completed"])
  })

  it("supports awaitable exit completion at BASE", async () => {
    const runtime = poseRuntime()
    runtime.poseTransition.pauseAt(1)
    runtime.poseDiagnostics.state = "ACTIVE_LOOP"
    const exited = runtime.exitPose({ waitUntil: "BASE" })
    runtime.clock.time = 80
    const sample = runtime.poseTransition.sample(80)
    runtime.updatePoseLifecycle(sample, 80)
    await exited
    expect(runtime.lifecycle.getHistory().map((entry: any) => entry.event.type)).toEqual(["pose.exit.started", "pose.exit.completed"])
  })

  it("cancels a queued replacement when the current pose is selected again", async () => {
    const runtime = poseRuntime()
    runtime.poseTransition.pauseAt(1)
    runtime.poseDiagnostics.state = "ACTIVE_LOOP"
    const pending = new AbortController()
    runtime.poseLoadController = pending
    runtime.poseDiagnostics.pendingId = "waiting"
    await runtime.enterPose("writing")
    expect(pending.signal.aborted).toBe(true)
    expect(runtime.poseLoadController).toBeNull()
    expect(runtime.poseDiagnostics.pendingId).toBeNull()
    expect(runtime.poseTransition.sample(0).state).toBe("ACTIVE_LOOP")
  })

  it("aborts an observer waiter without cancelling the active request", async () => {
    const runtime = poseRuntime()
    const entered = runtime.enterPose("writing")
    const controller = new AbortController()
    const observer = runtime.waitForPoseState("ACTIVE_LOOP", { signal: controller.signal })
    controller.abort("observer stopped")
    await expect(observer).rejects.toMatchObject({ name: "AbortError" })
    expect(runtime.activePoseRequest).not.toBeNull()
    expect(runtime.poseTransition.sample(0).state).toBe("ENTERING")
    expect(runtime.lifecycle.getHistory().map((entry: any) => entry.event.type)).toEqual(["pose.enter.started"])

    runtime.clock.time = 100
    runtime.updatePoseLifecycle(runtime.poseTransition.sample(100), 100)
    await entered
    expect(runtime.lifecycle.getHistory().map((entry: any) => entry.event.type)).toEqual(["pose.enter.started", "pose.enter.completed"])
  })

  it("cancels an aborted enter once and reverses it to BASE", async () => {
    const runtime = poseRuntime()
    const controller = new AbortController()
    const entered = runtime.enterPose("writing", { signal: controller.signal })
    runtime.clock.time = 40
    runtime.poseTransition.sample(40)
    controller.abort("task completed")
    await expect(entered).rejects.toMatchObject({ name: "AbortError" })
    expect(runtime.poseTransition.sample(40).state).toBe("EXITING")

    runtime.clock.time = 200
    runtime.updatePoseLifecycle(runtime.poseTransition.sample(200), 200)
    const events = runtime.lifecycle.getHistory().map((entry: any) => entry.event)
    expect(events.map((event: any) => event.type)).toEqual(["pose.enter.started", "pose.cancelled"])
    expect(events[1]).toMatchObject({ direction: "enter", settleTarget: "BASE" })
    expect(runtime.poseTransition.sample(200).state).toBe("BASE")
  })

  it("cancels an aborted exit once and reverses it to ACTIVE_LOOP", async () => {
    const runtime = poseRuntime()
    runtime.poseTransition.pauseAt(1)
    runtime.poseDiagnostics.state = "ACTIVE_LOOP"
    const controller = new AbortController()
    const exited = runtime.exitPose({ waitUntil: "BASE", signal: controller.signal })
    runtime.clock.time = 20
    runtime.poseTransition.sample(20)
    controller.abort("exit no longer wanted")
    await expect(exited).rejects.toMatchObject({ name: "AbortError" })
    expect(runtime.poseTransition.sample(20).state).toBe("ENTERING")

    runtime.clock.time = 200
    runtime.updatePoseLifecycle(runtime.poseTransition.sample(200), 200)
    const events = runtime.lifecycle.getHistory().map((entry: any) => entry.event)
    expect(events.map((event: any) => event.type)).toEqual(["pose.exit.started", "pose.cancelled"])
    expect(events[1]).toMatchObject({ direction: "exit", settleTarget: "ACTIVE_LOOP" })
    expect(runtime.poseTransition.sample(200).state).toBe("ACTIVE_LOOP")
  })

  it("cancels a timed-out operation and cleans up its waiter", async () => {
    vi.useFakeTimers()
    try {
      const runtime = poseRuntime()
      const entered = runtime.enterPose("writing", { timeoutMs: 25 })
      const rejection = expect(entered).rejects.toThrow("Timed out waiting for pose state ACTIVE_LOOP")
      await vi.advanceTimersByTimeAsync(25)
      await rejection
      expect(runtime.poseWaiters.size).toBe(0)
      expect(runtime.activePoseRequest).toBeNull()
      expect(runtime.lifecycle.getHistory().map((entry: any) => entry.event.type)).toEqual(["pose.enter.started", "pose.cancelled"])
    } finally {
      vi.useRealTimers()
    }
  })

  it("cancels a superseded enter and completes only the latest request", async () => {
    const runtime = poseRuntime()
    const firstResult = runtime.enterPose("writing").catch((error: Error) => error)
    const second = runtime.enterPose("writing")
    expect(await firstResult).toMatchObject({ name: "AbortError" })
    runtime.clock.time = 100
    runtime.updatePoseLifecycle(runtime.poseTransition.sample(100), 100)
    await second
    expect(runtime.lifecycle.getHistory().map((entry: any) => entry.event.type)).toEqual([
      "pose.enter.started", "pose.cancelled", "pose.enter.started", "pose.enter.completed",
    ])
  })

  it("cancels a superseded exit and completes only the latest request", async () => {
    const runtime = poseRuntime()
    runtime.poseTransition.pauseAt(1)
    runtime.poseDiagnostics.state = "ACTIVE_LOOP"
    const firstResult = runtime.exitPose({ waitUntil: "BASE" }).catch((error: Error) => error)
    const second = runtime.exitPose({ waitUntil: "BASE" })
    expect(await firstResult).toMatchObject({ name: "AbortError" })
    runtime.clock.time = 80
    runtime.updatePoseLifecycle(runtime.poseTransition.sample(80), 80)
    await second
    expect(runtime.lifecycle.getHistory().map((entry: any) => entry.event.type)).toEqual([
      "pose.exit.started", "pose.cancelled", "pose.exit.started", "pose.exit.completed",
    ])
  })

  it("resets a pending request to BASE without duplicate lifecycle events", async () => {
    const runtime = poseRuntime()
    const entered = runtime.enterPose("writing").catch((error: Error) => error)
    runtime.resetPose("model-unload")
    expect(await entered).toMatchObject({ name: "AbortError" })
    runtime.updatePoseLifecycle(runtime.poseTransition.sample(100), 100)
    expect(runtime.poseTransition.sample(100).state).toBe("BASE")
    expect(runtime.poseWaiters.size).toBe(0)
    expect(runtime.lifecycle.getHistory().map((entry: any) => entry.event.type)).toEqual(["pose.enter.started", "pose.cancelled"])
  })

  it("emits rejected for an unavailable pose", async () => {
    const runtime = poseRuntime()
    runtime.poseDiagnostics = { id: "writing", loadStatus: "rejected", state: "BASE", error: "registration rejected" }
    runtime.loadPoseById = async () => undefined
    await expect(runtime.enterPose("writing")).rejects.toThrow("registration rejected")
    expect(runtime.lifecycle.getHistory().at(-1)?.event.type).toBe("pose.rejected")
  })

  it("can stop waiting for an enter while preserving motion for the next pose", async () => {
    const runtime = poseRuntime()
    const controller = new AbortController()
    const entered = runtime.enterPose("writing", { signal: controller.signal, cancelOnAbort: false })
    runtime.clock.time = 40
    controller.abort("new pose selected")
    await expect(entered).rejects.toMatchObject({ name: "AbortError" })
    expect(runtime.poseTransition.sample(40).state).toBe("ENTERING")
    expect(runtime.poseWaiters.size).toBe(0)
    runtime.clock.time = 100
    runtime.updatePoseLifecycle(runtime.poseTransition.sample(100), 100)
    expect(runtime.lifecycle.getHistory().map((entry: any) => entry.event.type)).toEqual(["pose.enter.started", "pose.enter.completed"])
  })
})
