import type { RigDefinition, RigLayer } from "../engine/anime25d/types"
import type { PoseLayerSelection, PoseManifest } from "./types"

const normalizedLayerName = (name: string) => name.normalize("NFKC").trim().toLowerCase()
export const semanticLayerName = (name: string) => normalizedLayerName(name).replace(/[-_]([lr])$/i, "").replace(/_\d+$/, "").replace(/[ _-]front$/, "")
const isExactLayerSelector = (name: string) => /(?:[-_][lr]|_\d+)$/i.test(normalizedLayerName(name))
export const layerMatchesSelector = (name: string, selector: string) => isExactLayerSelector(selector)
  ? normalizedLayerName(name) === normalizedLayerName(selector)
  : semanticLayerName(name) === semanticLayerName(selector)
const matching = (layers: RigLayer[], selector: string) => layers.filter((layer) => layerMatchesSelector(layer.name, selector)).map((layer) => layer.name)

export function selectIndependentPoseLayers(base: RigDefinition, pose: RigDefinition): PoseLayerSelection {
  return {
    independentModel: true,
    baseShared: [],
    baseReplace: base.layers.map(layer => layer.name),
    poseReplace: pose.layers.map(layer => layer.name),
    poseAdditive: [],
    renderBehindBase: [],
    renderInFrontOfBase: [],
    errors: pose.layers.length ? [] : ["independent-model has no visible layers"],
    warnings: [],
  }
}

export function selectPoseLayers(base: RigDefinition, pose: RigDefinition, config: PoseManifest["layers"]): PoseLayerSelection {
  const errors: string[] = []
  const warnings: string[] = []
  const collect = (rig: RigDefinition, names: string[], required: boolean, owner: "base" | "pose") => names.flatMap((selector) => {
    const found = matching(rig.layers, selector)
    if (!found.length) (required ? errors : warnings).push(`${owner} layer selector '${selector}' was not found`)
    return found
  })
  const baseShared = collect(base, config.sharedFromBase, false, "base")
  const baseReplace = collect(base, config.replaceFromBase, true, "base")
  const poseReplace = collect(pose, config.useFromPose, true, "pose")
  const poseAdditive = collect(pose, config.addFromPose, true, "pose")
  for (const name of new Set(baseShared)) if (baseReplace.includes(name)) errors.push(`base layer '${name}' cannot be both shared and replaced`)
  for (const name of new Set(poseReplace)) if (poseAdditive.includes(name)) errors.push(`pose layer '${name}' cannot be both replacement and additive`)
  const selectedPose = new Set([...poseReplace, ...poseAdditive])
  for (const name of selectedPose) {
    const layer = pose.layers.find((candidate) => candidate.name === name)
    if (layer?.group === "head" || /^(face|eye|eyewhite|irides|eyelash|eyebrow|eye_close|front hair|back hair|mouth|nose|ears|earwear|headwear)/.test(semanticLayerName(name))) {
      errors.push(`pose head/identity layer '${name}' cannot be rendered by semantic-layer-swap`)
    }
  }
  for (const rule of [...(config.renderBehindBase ?? []), ...(config.renderInFrontOfBase ?? [])]) {
    if (![...selectedPose].some((name) => layerMatchesSelector(name, rule.pose))) errors.push(`pose render-order layer '${rule.pose}' is not selected`)
    if (!matching(base.layers, rule.base).length) errors.push(`base render-order layer '${rule.base}' was not found`)
  }
  if (!baseReplace.length || !poseReplace.length) errors.push("pose requires at least one base and pose replacement layer")
  return {
    baseShared: [...new Set(baseShared)],
    baseReplace: [...new Set(baseReplace)],
    poseReplace: [...new Set(poseReplace)],
    poseAdditive: [...new Set(poseAdditive)],
    renderBehindBase: [...(config.renderBehindBase ?? [])],
    renderInFrontOfBase: [...(config.renderInFrontOfBase ?? [])],
    errors,
    warnings,
  }
}
