import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
  createDefaultBehaviorProfile,
  behaviorUsesPoseVariants,
  parseBehaviorManifest,
  validateBehaviorPoseIds,
} from "../src/behavior/BehaviorManifest"

const valid = JSON.parse(readFileSync(new URL("./fixtures/profiles/legacy/behavior.json", import.meta.url), "utf8"))

describe("behavior manifests", () => {
  it("parses the checked-in finite and legacy profiles", () => {
    for (const name of ["finite", "legacy", "legacy-alt"]) {
      const json = JSON.parse(readFileSync(new URL(`./fixtures/profiles/${name}/behavior.json`, import.meta.url), "utf8"))
      const parsed = parseBehaviorManifest(json)
      expect(parsed.warnings).toEqual([])
      expect(parsed.value.states.BUSY.poseId).toBe("writing")
      expect(parsed.value.states.BORED.actions?.map((action) => action.id)).toEqual(["bored-look-away", "bored-sigh"])
    }
  })

  it("warns for unknown fields", () => {
    expect(parseBehaviorManifest({ ...valid, futureField: true }).warnings).toContain("behavior: unknown field 'futureField'")
  })

  it("rejects negative durations", () => {
    expect(() => parseBehaviorManifest({ ...valid, timing: { ...valid.timing, happyDurationMs: -1 } })).toThrow(/non-negative/)
  })

  it("rejects unknown state names", () => {
    expect(() => parseBehaviorManifest({ ...valid, states: { ...valid.states, SLEEPY: { poseId: null } } })).toThrow(/unknown state 'SLEEPY'/)
  })

  it("reports unavailable state poses without rejecting parameter fallback", () => {
    const profile = { ...parseBehaviorManifest(valid).value, sourceUrl: "behavior.json", warnings: [], usedDefault: false }
    expect(validateBehaviorPoseIds(profile, ["memo-check"])).toEqual(["behavior state BUSY references unavailable pose 'writing'; parameter fallback will be used"])
  })

  it("provides a complete default profile when character.behavior is absent", () => {
    const profile = createDefaultBehaviorProfile()
    expect(profile.usedDefault).toBe(true)
    expect(profile.states).toHaveProperty("NORMAL")
    expect(profile.states.BUSY.fallbackMotion).toBeDefined()
  })
})

describe("pose variant manifests", () => {
  it("parses state and action choices while preserving legacy defaults", () => {
    const input = structuredClone(valid)
    input.states.NORMAL = { poseId: "waiting", poseVariants: ["waiting-clasp", "waiting-wave"], poseVariantIntervalMs: 18_000 }
    input.interactionReactions = { HEAD_TAP: { id: "head", poseId: "head-tap", poseVariants: ["bunny", "salute"], durationMs: 1000, motion: { loopDurationMs: 1000, parameters: {} } } }
    const parsed = parseBehaviorManifest(input)
    expect(parsed.warnings).toEqual([])
    expect(behaviorUsesPoseVariants(parsed.value)).toBe(true)
    expect(behaviorUsesPoseVariants(parseBehaviorManifest(valid).value)).toBe(false)
    expect(parsed.value.interactionReactions?.HEAD_TAP?.poseVariants).toEqual(["bunny", "salute"])
    expect(validateBehaviorPoseIds({ ...parsed.value, sourceUrl: null, warnings: [], usedDefault: false }, ["writing", "waiting", "waiting-clasp", "waiting-wave", "head-tap", "bunny"]))
      .toEqual(["behavior HEAD_TAP references unavailable variant pose 'salute'; available poses will be used"])
  })

  it.each([
    { poseVariants: [] }, { poseVariants: ["waiting"] }, { poseVariants: ["wave", "wave"] },
    { poseVariants: [""] }, { poseVariants: Array.from({ length: 8 }, (_, i) => `pose-${i}`) },
    { poseId: null, poseVariants: ["wave"] }, { poseVariantIntervalMs: 18_000 },
    { poseVariants: ["wave"], poseVariantIntervalMs: 4999 },
    { poseVariants: ["wave"], poseVariantIntervalMs: 300_001 },
  ])("rejects invalid variant state %j", fields => {
    expect(() => parseBehaviorManifest({ ...valid, states: { ...valid.states, NORMAL: { poseId: "waiting", ...fields } } })).toThrow()
  })
})


describe("optional continuous reaction profiles", () => {
  const motion = { loopDurationMs: 1800, parameters: { eyeOpenL: { type:"constant", value:.6 } } }
  it("leaves existing profiles on their legacy procedural path", () => {
    expect(parseBehaviorManifest(valid).value.continuousReactions).toBeUndefined()
  })
  it("parses local reaction configuration and reports its missing pose", () => {
    const parsed=parseBehaviorManifest({...valid,continuousReactions:{PET:{poseId:'head-pet',motion},HOLD:{motion}}})
    expect(parsed.warnings).toEqual([])
    expect(parsed.value.continuousReactions?.PET).toMatchObject({enterMs:180,releaseMs:280,workScale:.55})
    expect(validateBehaviorPoseIds({...parsed.value,sourceUrl:null,warnings:[],usedDefault:false},['writing'])).toContain("behavior continuous PET references unavailable pose 'head-pet'; that reaction will be unavailable")
  })
  it.each([
    {workScale:1.1}, {enterMs:-1}, {releaseMs:2001},
    {motion:{...motion,playback:'once'}},
    {motion:{...motion,parameters:{body:{type:'constant',value:.1}}}},
  ])("rejects an unsupported continuous setting %j", overrides => {
    expect(()=>parseBehaviorManifest({...valid,continuousReactions:{PET:{motion,...overrides}}})).toThrow()
  })
})
