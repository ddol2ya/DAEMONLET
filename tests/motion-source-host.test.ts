import { describe, expect, it } from "vitest"
import { ParameterMixer } from "../src/interaction/ParameterMixer"
import { MotionSourceHost } from "../src/motion/orchestration/MotionSourceHost"

describe("MotionSourceHost", () => {
  it("acquires, updates and releases a source lease", () => {
    const mixer = new ParameterMixer()
    const host = new MotionSourceHost(mixer, () => 10)
    const lease = host.acquire({ slot: "idle", ownerId: "runtime", priority: 1 })
    lease.update({ angleX: 0.4 })
    expect(mixer.evaluate().angleX).toBeCloseTo(0.4)
    expect(lease.active()).toBe(true)
    lease.release()
    expect(mixer.evaluate().angleX).toBe(0)
    expect(lease.active()).toBe(false)
  })

  it("prevents a superseded lease from updating or removing the new owner", () => {
    const mixer = new ParameterMixer()
    const host = new MotionSourceHost(mixer)
    const oldLease = host.acquire({ slot: "behavior-state", ownerId: "old", priority: 11 })
    oldLease.update({ angleX: 0.2 })
    const newLease = host.acquire({ slot: "behavior-state", ownerId: "new", priority: 11 })
    newLease.update({ angleX: 0.7 })
    oldLease.update({ angleX: -0.8 })
    oldLease.release()
    expect(mixer.evaluate().angleX).toBeCloseTo(0.7)
    expect(newLease.active()).toBe(true)
    expect(host.diagnostics().map(({ ownerId, status }) => [ownerId, status])).toEqual([["old", "superseded"], ["new", "active"]])
  })

  it("releases only matching owners and invalidates every stale lease on clear", () => {
    const mixer = new ParameterMixer()
    const host = new MotionSourceHost(mixer)
    const a = host.acquire({ slot: "a", ownerId: "owner-a", priority: 1 })
    const b = host.acquire({ slot: "b", ownerId: "owner-b", priority: 1 })
    a.update({ angleX: 0.2 })
    b.update({ angleY: 0.3 })
    host.releaseOwner("owner-a")
    expect(a.active()).toBe(false)
    expect(b.active()).toBe(true)
    host.clear()
    b.update({ angleY: 0.9 })
    expect(b.active()).toBe(false)
    expect(mixer.evaluate()).toMatchObject({ angleX: 0, angleY: 0 })
  })

  it("reports tokens, parameters and mode overrides", () => {
    const mixer = new ParameterMixer()
    const host = new MotionSourceHost(mixer)
    const lease = host.acquire({ slot: "manual", ownerId: "debug", priority: 100 })
    lease.update({ angleX: 0.5, eyeX: 0.4 }, { modes: { angleX: "override", eyeX: "override" } })
    expect(host.diagnostics().at(-1)).toMatchObject({
      slot: "manual", ownerId: "debug", token: lease.token, priority: 100, activeParameterCount: 2,
      modeOverrides: { angleX: "override", eyeX: "override" }, status: "active",
    })
  })
})
