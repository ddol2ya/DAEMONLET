import { describe, expect, it } from "vitest"
import { PoseRegistry } from "../src/pose/PoseRegistry"
import type { PoseManifest } from "../src/pose/types"

const manifest = (id: string): PoseManifest => ({
  schemaVersion: 1,
  id,
  label: id === "writing" ? "Writing" : "Memo Check",
  source: "source/reference.png",
  psd: `rigged/${id}.psd`,
  strategy: "semantic-layer-swap",
  registration: { strategy: "eyes-and-neck", maxScaleDelta: 0.06, maxRotationDeg: 3, maxAnchorErrorPx: 18 },
  layers: { sharedFromBase: ["face"], replaceFromBase: ["handwear_2"], useFromPose: ["handwear_2"], addFromPose: ["objects"] },
  transition: { enterMs: 900, exitMs: 720, swapStart: 0.28, swapEnd: 0.72 },
})

describe("PoseRegistry", () => {
  it("lists multiple pose manifests and resolves by id", () => {
    const registry = new PoseRegistry()
    registry.replace([
      { manifest: manifest("memo-check"), manifestUrl: "/memo/pose.json" },
      { manifest: manifest("writing"), manifestUrl: "/writing/pose.json" },
    ])
    expect(registry.list("writing", "writing")).toEqual([
      expect.objectContaining({ id: "memo-check", loaded: false, active: false }),
      expect.objectContaining({ id: "writing", loaded: true, active: true }),
    ])
    expect(registry.resolve("writing").manifest.label).toBe("Writing")
    expect(() => registry.resolve("missing")).toThrow(/Unknown pose id 'missing'.*memo-check, writing/)
  })

  it("rejects duplicate ids before mutating the current registry", () => {
    const registry = new PoseRegistry()
    registry.replace([{ manifest: manifest("memo-check"), manifestUrl: "/memo/pose.json" }])
    expect(() => registry.replace([
      { manifest: manifest("writing"), manifestUrl: "/one.json" },
      { manifest: manifest("writing"), manifestUrl: "/two.json" },
    ])).toThrow(/duplicate pose id/)
    expect(registry.resolve("memo-check").manifest.id).toBe("memo-check")
  })
})
