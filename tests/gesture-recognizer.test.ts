import { describe, expect, it } from "vitest"
import { GestureRecognizer } from "../src/interaction/GestureRecognizer"

describe("GestureRecognizer", () => {
  it("recognizes tap", () => {
    const gesture = new GestureRecognizer()
    gesture.start(10, 10, 0, "head")
    expect(gesture.end(11, 11, 120).map((event) => event.type)).toEqual(["tap"])
  })

  it("recognizes a 480ms hold", () => {
    const gesture = new GestureRecognizer()
    gesture.start(10, 10, 0, "face")
    expect(gesture.update(479)).toEqual([])
    expect(gesture.update(480)[0].type).toBe("hold-start")
    expect(gesture.move(11, 10, 520)[0].type).toBe("hold-loop")
    expect(gesture.end(11, 10, 600)[0].type).toBe("hold-end")
  })

  it("recognizes drag after 12px", () => {
    const gesture = new GestureRecognizer()
    gesture.start(0, 0, 0, "torso")
    expect(gesture.move(8, 0, 20)).toEqual([])
    expect(gesture.move(12, 0, 30).map((event) => event.type)).toEqual(["drag-start", "drag"])
  })

  it("closes a hold before transitioning to drag", () => {
    const gesture = new GestureRecognizer()
    gesture.start(0, 0, 0, "face")
    expect(gesture.update(480).map((event) => event.type)).toEqual(["hold-start"])
    expect(gesture.move(4, 0, 500).map((event) => event.type)).toEqual(["hold-loop"])
    expect(gesture.move(12, 0, 520).map((event) => event.type)).toEqual(["hold-end", "drag-start", "drag"])
    expect(gesture.end(12, 0, 540).map((event) => event.type)).toEqual(["drag-end"])
  })

  it("closes holds and drags on pointer cancel", () => {
    const hold = new GestureRecognizer()
    hold.start(0, 0, 0, "face")
    hold.update(480)
    expect(hold.cancel(500).map((event) => event.type)).toEqual(["hold-end"])

    const drag = new GestureRecognizer()
    drag.start(0, 0, 0, "head")
    drag.move(12, 0, 10)
    expect(drag.cancel(20).map((event) => event.type)).toEqual(["drag-end"])
  })

  it("recognizes head petting after 24px horizontal travel", () => {
    const gesture = new GestureRecognizer()
    gesture.start(50, 20, 0, "head")
    gesture.move(30, 20, 20)
    expect(gesture.move(65, 20, 40).map((event) => event.type)).toEqual(["drag", "pet-start", "pet-loop"])
    expect(gesture.end(65, 20, 60)[0].type).toBe("pet-end")
  })
  it.each(["head", "face"] as const)("recognizes a short stroke starting on %s and ends it once", area => {
    const gesture = new GestureRecognizer()
    gesture.start(0, 0, 0, area)
    expect(gesture.move(23, 0, 30).some(e => e.type === "pet-start")).toBe(false)
    expect(gesture.move(24, 0, 40).map(e => e.type)).toContain("pet-start")
    expect(gesture.cancel(50).map(e => e.type)).toEqual(["pet-end"])
    expect(gesture.cancel(60)).toEqual([])
  })

  it("transfers a face hold to petting and never pets the torso", () => {
    const gesture = new GestureRecognizer()
    gesture.start(0, 0, 0, "face"); gesture.update(480)
    expect(gesture.move(25, 0, 500).map(e => e.type)).toEqual(["hold-end", "drag-start", "drag", "pet-start", "pet-loop"])
    gesture.start(0, 0, 600, "torso")
    expect(gesture.move(40, 0, 700).map(e => e.type)).toEqual(["drag-start", "drag"])
  })
})
