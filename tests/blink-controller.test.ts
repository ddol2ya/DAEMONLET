import { describe, expect, it } from "vitest"
import { BlinkController } from "../src/motion/sources/BlinkController"

class FakeClock {
  constructor(public time = 0) {}
  now() { return this.time }
}

const fixedConfig = {
  intervalMinMs: 100,
  intervalMaxMs: 100,
  closeDurationMs: 10,
  closedHoldMinMs: 20,
  closedHoldMaxMs: 20,
  openDurationMinMs: 30,
  openDurationMaxMs: 30,
}

describe("BlinkController", () => {
  it("runs IDLE → CLOSING → CLOSED → OPENING → IDLE", () => {
    const clock = new FakeClock()
    const blink = new BlinkController({ clock, random: () => 0, config: fixedConfig })
    expect(blink.update({ now: 0, baselineEyeOpenL: 1, baselineEyeOpenR: 1, enabled: true }).phase).toBe("IDLE")
    expect(blink.update({ now: 100, baselineEyeOpenL: 1, baselineEyeOpenR: 1, enabled: true }).phase).toBe("CLOSING")
    expect(blink.update({ now: 110, baselineEyeOpenL: 1, baselineEyeOpenR: 1, enabled: true })).toMatchObject({ phase: "CLOSED", eyeOpenL: 0 })
    expect(blink.update({ now: 130, baselineEyeOpenL: 1, baselineEyeOpenR: 1, enabled: true }).phase).toBe("OPENING")
    expect(blink.update({ now: 160, baselineEyeOpenL: 1, baselineEyeOpenR: 1, enabled: true })).toMatchObject({ phase: "IDLE", eyeOpenL: 1 })
  })

  it("closes from and returns to the captured expression baseline", () => {
    const clock = new FakeClock()
    const blink = new BlinkController({ clock, random: () => 0, config: fixedConfig })
    blink.trigger()
    expect(blink.update({ now: 0, baselineEyeOpenL: 0.72, baselineEyeOpenR: 0.68, enabled: true })).toMatchObject({ eyeOpenL: 0.72, eyeOpenR: 0.68 })
    expect(blink.update({ now: 5, baselineEyeOpenL: 0.72, baselineEyeOpenR: 0.68, enabled: true })).toMatchObject({ eyeOpenL: 0.36, eyeOpenR: 0.34 })
    expect(blink.update({ now: 60, baselineEyeOpenL: 0.72, baselineEyeOpenR: 0.68, enabled: true })).toMatchObject({ eyeOpenL: 0.72, eyeOpenR: 0.68 })
    expect(blink.getDiagnostics().forcedBlinkCount).toBe(1)
  })

  it("suppresses automatic blinking for already closed eyes but allows a forced blink", () => {
    const clock = new FakeClock()
    const blink = new BlinkController({ clock, random: () => 0, config: fixedConfig })
    expect(blink.update({ now: 100, baselineEyeOpenL: 0.1, baselineEyeOpenR: 0.1, enabled: true }).phase).toBe("IDLE")
    blink.trigger()
    expect(blink.update({ now: 101, baselineEyeOpenL: 0.1, baselineEyeOpenR: 0.1, enabled: true }).phase).toBe("CLOSING")
  })

  it("schedules deterministic intervals in range and resets safely when disabled", () => {
    const clock = new FakeClock()
    const blink = new BlinkController({ clock, random: () => 0.25, config: { intervalMinMs: 3000, intervalMaxMs: 8000 } })
    expect(blink.getDiagnostics().nextBlinkInMs).toBe(4250)
    blink.trigger()
    blink.update({ now: 0, baselineEyeOpenL: 1, baselineEyeOpenR: 1, enabled: true })
    expect(blink.update({ now: 1, baselineEyeOpenL: 1, baselineEyeOpenR: 1, enabled: false }).phase).toBe("IDLE")
  })

  it("does not decay the baseline over repeated cycles", () => {
    const clock = new FakeClock()
    const blink = new BlinkController({ clock, random: () => 0, config: fixedConfig })
    for (let cycle = 0; cycle < 3; cycle++) {
      const start = cycle * 200
      blink.trigger()
      blink.update({ now: start, baselineEyeOpenL: 0.72, baselineEyeOpenR: 0.72, enabled: true })
      const completed = blink.update({ now: start + 60, baselineEyeOpenL: 0.72, baselineEyeOpenR: 0.72, enabled: true })
      expect(completed.eyeOpenL).toBe(0.72)
    }
  })
})
