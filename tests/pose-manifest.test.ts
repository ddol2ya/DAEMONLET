import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { parseCatalogManifest, parseCharacterManifest, parsePoseManifest } from "../src/pose/PoseManifest"

const pose = {
  schemaVersion: 1,
  id: "memo-check",
  label: "Memo Check",
  source: "source/reference.png",
  psd: "rigged/memo-check.psd",
  strategy: "semantic-layer-swap",
  registration: { strategy: "eyes-and-neck", maxScaleDelta: 0.06, maxRotationDeg: 3, maxAnchorErrorPx: 18 },
  layers: { sharedFromBase: ["face"], replaceFromBase: ["topwear"], useFromPose: ["topwear"], addFromPose: ["objects"] },
  transition: { enterMs: 760, exitMs: 620, swapStart: 0.32, swapEnd: 0.68 },
  motion: {
    loopDurationMs: 1100,
    parameters: { eyeY: { type: "constant", value: 0.2 } },
    layers: { handwear_2: {
      origin: { x: 0.16, y: 0.88 },
      influence: { axisX: 0.85, axisY: 0.53, start: 0.07, end: 0.18 },
      translateX: { type: "sine", amplitude: 2.5, phase: 0 },
    } },
  },
  interactionScale: { TORSO_TAP: 0.5 },
}

describe("pose manifests", () => {
  it("validates character and pose manifests", () => {
    expect(parseCharacterManifest({ schemaVersion: 1, id: "momo", label: "Momo", base: { source: "a.png", psd: "a.psd" }, poses: ["pose.json"] }).value.id).toBe("momo")
    expect(parsePoseManifest(pose).value.transition.enterMs).toBe(760)
    expect(parsePoseManifest(pose).value.motion?.layers.handwear_2.translateX).toMatchObject({ type: "sine", amplitude: 2.5, offset: 0 })
    expect(parsePoseManifest(pose).value.motion?.layers.handwear_2.origin).toEqual({ x: 0.16, y: 0.88 })
    expect(parsePoseManifest(pose).value.motion?.layers.handwear_2.influence).toEqual({ axisX: 0.85, axisY: 0.53, start: 0.07, end: 0.18 })
    expect(parsePoseManifest(pose).value.interactionScale?.TORSO_TAP).toBe(0.5)
  })

  it("parses cross-source pose occlusion rules", () => {
    const result = parsePoseManifest({ ...pose, layers: {
      ...pose.layers,
      renderBehindBase: [{ pose: "topwear", base: "neck" }],
      renderInFrontOfBase: [{ pose: "objects", base: "front hair" }],
    } })
    expect(result.value.layers.renderBehindBase).toEqual([{ pose: "topwear", base: "neck" }])
    expect(result.value.layers.renderInFrontOfBase).toEqual([{ pose: "objects", base: "front hair" }])
  })

  it("warns on unknown fields and rejects invalid swap ranges", () => {
    expect(parsePoseManifest({ ...pose, futureField: true }).warnings).toContain("pose: unknown field 'futureField'")
    expect(() => parsePoseManifest({ ...pose, transition: { ...pose.transition, swapStart: 0.8, swapEnd: 0.2 } })).toThrow(/swap range/)
    expect(() => parsePoseManifest({ ...pose, motion: { ...pose.motion, parameters: { nope: { type: "constant", value: 1 } } } })).toThrow(/unknown parameter/)
    expect(() => parsePoseManifest({ ...pose, motion: { ...pose.motion, layers: { handwear_2: {
      translateX: { type: "constant", value: 1 },
      influence: { axisX: 0, axisY: 0, start: 0, end: 1 },
    } } } })).toThrow(/axis must be non-zero/)
  })

  it("validates every checked-in catalog manifest", () => {
    const json = (path: string) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"))
    const catalog = parseCatalogManifest(json("public/characters/catalog.json"))
    expect(catalog.warnings).toEqual([])
    for (const characterPath of catalog.value.characters) {
      const character = parseCharacterManifest(json(`public/characters/${characterPath}`))
      expect(character.warnings).toEqual([])
      for (const posePath of character.value.poses) {
        const directory = characterPath.slice(0, characterPath.lastIndexOf("/") + 1)
        expect(parsePoseManifest(json(`public/characters/${directory}${posePath}`)).warnings).toEqual([])
      }
    }
  })
})
