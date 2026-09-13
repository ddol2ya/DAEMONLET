import type { PointerGestureSignal } from "../src/interaction/types"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { InteractionController } from "../src/interaction/InteractionController"

type PointerLike = {
  pointerId: number
  pointerType: string
  clientX: number
  clientY: number
  buttons: number
}

class FakeCanvas {
  private readonly listeners = new Map<string, Set<(event: PointerLike) => void>>()
  private readonly captures = new Set<number>()

  addEventListener(type: string, listener: (event: PointerLike) => void) {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: (event: PointerLike) => void) {
    this.listeners.get(type)?.delete(listener)
  }

  emit(type: string, event: Partial<PointerLike> = {}) {
    const pointer = {
      pointerId: 1,
      pointerType: "mouse",
      clientX: 20,
      clientY: 20,
      buttons: 0,
      ...event,
    }
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(pointer)
  }

  setPointerCapture(pointerId: number) {
    this.captures.add(pointerId)
  }

  hasPointerCapture(pointerId: number) {
    return this.captures.has(pointerId)
  }

  releasePointerCapture(pointerId: number) {
    this.captures.delete(pointerId)
    this.emit("lostpointercapture", { pointerId })
  }

  losePointerCapture(pointerId: number) {
    this.captures.delete(pointerId)
    this.emit("lostpointercapture", { pointerId })
  }

  listenerCount(type: string) {
    return this.listeners.get(type)?.size ?? 0
  }

  captured(pointerId: number) {
    return this.captures.has(pointerId)
  }
}

class FakeRuntime {
  revision = 1
  area: "head" | "face" = "head"
  target: { x: number; y: number } | null = null
  cancellations: string[] = []
  interactions: string[] = []
  diagnostics = { pointerModel: null as { x: number; y: number } | null }

  clientToModel(clientX: number, clientY: number) {
    return { x: clientX, y: clientY, inside: clientX >= 0 && clientX <= 100 && clientY >= 0 && clientY <= 100 }
  }
  getHitAreaResolver() { return { resolve: () => this.area } }
  getModelRevision() { return this.revision }
  setPointerTarget(x: number, y: number) { this.target = { x, y } }
  clearPointerTarget() { this.target = null }
  updateInputDiagnostics(pointer: { x: number; y: number } | null) {
    this.diagnostics.pointerModel = pointer
  }
  getDiagnostics() { return this.diagnostics }
  triggerInteraction(id: string) { this.interactions.push(id) }
  cancelInteraction(reason: string) { this.cancellations.push(reason) }
}

function setup() {
  const canvas = new FakeCanvas()
  const runtime = new FakeRuntime()
  const controller = new InteractionController(canvas as unknown as HTMLCanvasElement, runtime as any)
  return { canvas, runtime, controller }
}

beforeEach(() => {
  vi.stubGlobal("window", {
    setTimeout: (...args: Parameters<typeof globalThis.setTimeout>) => globalThis.setTimeout(...args),
    clearTimeout: (id: ReturnType<typeof globalThis.setTimeout>) => globalThis.clearTimeout(id),
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("InteractionController pointer lifecycle", () => {
  it.each([{ clientX: -1 }, { clientX: 101 }, { clientY: -1 }, { clientY: 101 }])("clears gaze on an outside move without pointerleave: %j", position => {
    const { canvas, runtime, controller } = setup()
    canvas.emit("pointermove", { clientX: 90, clientY: 90 })
    expect(runtime.target).toEqual({ x: 90, y: 90 })
    canvas.emit("pointermove", position)
    expect(runtime.target).toBeNull()
    expect(runtime.diagnostics.pointerModel).toBeNull()
    canvas.emit("pointermove", { clientX: 40, clientY: 30 })
    expect(runtime.target).toEqual({ x: 40, y: 30 })
    controller.destroy()
  })
  it("keeps mouse hover gaze when pointerup is inside", () => {
    const { canvas, runtime } = setup()
    canvas.emit("pointerdown", { buttons: 1, clientX: 10, clientY: 10 })
    canvas.emit("pointerup", { clientX: 30, clientY: 40 })
    expect(runtime.target).toEqual({ x: 30, y: 40 })
    expect(runtime.cancellations).toEqual([])
  })

  it("clears mouse gaze when pointerup is outside", () => {
    const { canvas, runtime } = setup()
    canvas.emit("pointerdown", { buttons: 1 })
    canvas.emit("pointerup", { clientX: 140, clientY: 40 })
    expect(runtime.target).toBeNull()
    expect(runtime.diagnostics.pointerModel).toBeNull()
  })

  it("always clears touch gaze on pointerup", () => {
    const { canvas, runtime } = setup()
    canvas.emit("pointerdown", { pointerType: "touch", buttons: 1 })
    canvas.emit("pointerup", { pointerType: "touch", clientX: 30, clientY: 40 })
    expect(runtime.target).toBeNull()
  })

  it("cleans up a pointercancel and ignores its later pointerup", () => {
    const { canvas, runtime } = setup()
    canvas.emit("pointerdown", { buttons: 1 })
    canvas.emit("pointercancel")
    canvas.emit("pointerup")
    expect(runtime.target).toBeNull()
    expect(runtime.cancellations).toEqual(["pointer-cancel"])
    expect(runtime.interactions).toEqual([])
  })

  it("cancels unexpected lost capture exactly once", () => {
    const { canvas, runtime } = setup()
    canvas.emit("pointerdown", { buttons: 1 })
    canvas.losePointerCapture(1)
    canvas.emit("lostpointercapture")
    expect(runtime.target).toBeNull()
    expect(runtime.cancellations).toEqual(["lost-pointer-capture"])
  })

  it("does not cancel again when normal pointerup releases capture", () => {
    const { canvas, runtime } = setup()
    canvas.emit("pointerdown", { buttons: 1 })
    canvas.emit("pointerup")
    expect(runtime.interactions).toEqual(["HEAD_TAP"])
    expect(runtime.cancellations).toEqual([])
  })

  it("clears state and removes every listener on destroy", () => {
    const { canvas, runtime, controller } = setup()
    canvas.emit("pointerdown", { buttons: 1 })
    controller.destroy()
    expect(runtime.target).toBeNull()
    expect(runtime.cancellations).toEqual(["controller-destroy"])
    expect(canvas.captured(1)).toBe(false)
    for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel", "pointerleave", "lostpointercapture"]) {
      expect(canvas.listenerCount(type)).toBe(0)
    }
  })

  it("cleans up a gesture when the model revision changes", () => {
    const { canvas, runtime } = setup()
    canvas.emit("pointerdown", { buttons: 1 })
    runtime.revision++
    canvas.emit("pointermove", { buttons: 1, clientX: 40 })
    canvas.emit("pointerup", { clientX: 40 })
    expect(runtime.target).toBeNull()
    expect(runtime.cancellations).toEqual(["model-revision-mismatch"])
    expect(runtime.interactions).toEqual([])
  })
})


describe("physical press ownership", () => {
  const owned = (area:"head"|"face"="head") => {
    const canvas=new FakeCanvas(),runtime=new FakeRuntime(),signals:PointerGestureSignal[]=[]
    runtime.area=area
    const controller=new InteractionController(canvas as unknown as HTMLCanvasElement,runtime as any,undefined,signal=>{signals.push(signal);return signal.type==='continuous'})
    return {canvas,runtime,signals,controller}
  }
  it("delivers one pet start, ignores simultaneous DRAG, and keeps one token through stillness/end", () => {
    vi.useFakeTimers()
    const {canvas,runtime,signals,controller}=owned()
    canvas.emit('pointerdown',{buttons:1})
    canvas.emit('pointermove',{clientX:80,buttons:1})
    canvas.emit('pointermove',{clientX:10,buttons:1})
    vi.advanceTimersByTime(5000)
    expect(signals.filter(s=>s.type==='continuous'&&s.phase==='start')).toHaveLength(1)
    expect(runtime.interactions).toEqual([])
    canvas.emit('pointerup',{clientX:10})
    expect(signals.filter(s=>s.type==='continuous'&&s.phase==='end')).toHaveLength(1)
    expect(signals.filter(s=>s.type==='end')).toHaveLength(1)
    expect(new Set(signals.map(s=>s.gestureId)).size).toBe(1)
    const previous=signals[0].gestureId
    canvas.emit('pointerdown',{buttons:1});canvas.emit('pointerup')
    expect(signals.at(-1)?.gestureId).not.toBe(previous)
    expect(runtime.interactions).toEqual(['HEAD_TAP'])
    controller.destroy()
  })
  it("keeps the 480ms face threshold and never adds a tap after release", () => {
    vi.useFakeTimers()
    const {canvas,runtime,signals,controller}=owned('face')
    canvas.emit('pointerdown',{buttons:1})
    vi.advanceTimersByTime(479)
    expect(signals.filter(s=>s.type==='continuous')).toEqual([])
    vi.advanceTimersByTime(1)
    expect(signals.at(-1)).toMatchObject({type:'continuous',interactionId:'HOLD',phase:'start'})
    vi.advanceTimersByTime(3000);canvas.emit('pointerup')
    expect(runtime.interactions).toEqual([])
    expect(signals.filter(s=>s.type==='end')).toHaveLength(1)
    controller.destroy()
  })
  it.each(['head','face'] as const)("recognizes captured native %s strokes even when moves report buttons=0", area => {
    const {canvas,runtime,signals,controller}=owned(area)
    canvas.emit('pointerdown',{buttons:1})
    canvas.emit('pointermove',{clientX:75,buttons:0})
    expect(signals.at(-1)).toMatchObject({type:'continuous',interactionId:'PET',phase:'loop'})
    canvas.emit('pointerleave',{clientX:75,buttons:0})
    expect(runtime.target).toEqual({x:75,y:20})
    canvas.emit('pointerup',{clientX:75,buttons:0})
    expect(signals.filter(s=>s.type==='continuous'&&s.phase==='end')).toHaveLength(1)
    expect(runtime.interactions).toEqual([])
    const count=signals.length
    canvas.emit('pointermove',{clientX:20,buttons:0})
    expect(signals).toHaveLength(count)
    controller.destroy()
  })
  it.each(['pointercancel','lostpointercapture','destroy','model-change'])("ends a held press on %s without a later start", reason => {
    vi.useFakeTimers()
    const {canvas,runtime,signals,controller}=owned('face')
    canvas.emit('pointerdown',{buttons:1})
    if(reason==='destroy')controller.destroy()
    else if(reason==='model-change')runtime.revision++
    else canvas.emit(reason)
    vi.advanceTimersByTime(800)
    canvas.emit('pointerup')
    expect(signals.filter(s=>s.type==='end')).toHaveLength(1)
    expect(signals.filter(s=>s.type==='continuous')).toEqual([])
    controller.destroy()
  })
})
