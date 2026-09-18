import { describe, expect, it } from "vitest"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { CharacterTransitionTrace } from "../electron/main/CharacterTransitionTrace"
import { parseCharacterLoadDiagnostic } from "../electron/shared/character-load-diagnostics"

describe("bounded character transition evidence", () => {
  const event = { loadId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", epoch: 1, id: "style-a", revision: "a".repeat(64), stage: "decode", elapsedMs: 10, hidden: false }
  it("accepts only structural stage events without paths, URLs or free-form errors", () => {
    expect(parseCharacterLoadDiagnostic(event)).toEqual(event)
    for (const patch of [{ path: "/private/input" }, { url: "https://fixture.invalid/token" }, { error: "private message" }, { stage: "unknown" }, { epoch: NaN }, { elapsedMs: -1 }, { id: "../private" }]) {
      expect(parseCharacterLoadDiagnostic({ ...event, ...patch })).toBeNull()
    }
  })
  it("retains only the last 128 transition events in an atomic profile record", async () => {
    const root = await mkdtemp(join(tmpdir(), "character-trace-"))
    try {
      const trace = new CharacterTransitionTrace(root)
      for (let i = 0; i < 132; i++) trace.record({ event: "request", requestId: String(i), rendererGeneration: 1, target: { id: "style-a", revision: "a".repeat(64) }, selected: null, lastReady: null,
        locks: { waiters: 0, chatApplying: false, chatPhase: "idle", packApplying: false, packTarget: null, quitting: false, updatePreparing: false, inputAllowed: true } })
      await trace.flush()
      const saved = JSON.parse(await readFile(join(root, "character-transitions.json"), "utf8"))
      expect(saved.events).toHaveLength(128)
      expect(saved.events[0].requestId).toBe("4")
      expect(saved.events.at(-1).requestId).toBe("131")
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
