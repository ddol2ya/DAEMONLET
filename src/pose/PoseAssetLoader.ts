import { loadRigAsync, rigDecodeCacheBytes } from "../engine/anime25d/loadRigAsync"
import { PsdRigLoader } from "../engine/anime25d/PsdRigLoader"
import type { RigOverrides } from "../engine/anime25d/RigOverrides"
import type { RigDefinition, RigLoadResult } from "../engine/anime25d/types"
import { layerMatchesSelector, selectIndependentPoseLayers, selectPoseLayers } from "./PoseLayerSelector"
import { loadPoseManifest, resolveManifestUrl } from "./PoseManifest"
import { registerPose } from "./PoseRegistration"
import type { PoseAsset, PoseManifest } from "./types"

async function response(url: string, signal?: AbortSignal) {
  const result = await fetch(url, { cache: "no-store", signal })
  if (!result.ok) throw new Error(`${url} could not be loaded (${result.status})`)
  return result
}

export class PoseAssetLoader {
  private cacheBase: RigDefinition | null = null
  private readonly cache = new Map<string, PoseAsset>()
  constructor(private readonly loader = new PsdRigLoader()) {}

  clear(): void { this.cache.clear(); this.cacheBase = null }
  get cachedAssetCount(): number { return this.cache.size }
  adopt(baseRig: RigDefinition, assets: PoseAsset[]): void {
    this.clear(); this.cacheBase = baseRig
    for (const asset of assets.slice(-16)) this.cache.set(`${asset.manifestUrl}\n${JSON.stringify(asset.manifest)}`, asset)
  }

  async load(manifestUrl: string, baseRig: RigDefinition, options: { signal?: AbortSignal; manifest?: PoseManifest; prepared?: RigLoadResult } = {}): Promise<PoseAsset> {
    const parsed = options.manifest ? { value: options.manifest, warnings: [] } : await loadPoseManifest(manifestUrl, options.signal)
    const manifest = parsed.value
    options.signal?.throwIfAborted()
    if (this.cacheBase !== baseRig) { this.clear(); this.cacheBase = baseRig }
    const cacheKey = `${manifestUrl}\n${JSON.stringify(manifest)}`
    const cached = this.cache.get(cacheKey)
    if (cached) {
      this.cache.delete(cacheKey)
      this.cache.set(cacheKey, cached)
      return cached
    }
    const psdUrl = resolveManifestUrl(manifest.psd, manifestUrl)
    const sourceUrl = resolveManifestUrl(manifest.source, manifestUrl)
    let result = options.prepared
    if (!result) {
      const [psdResponse, overrides] = await Promise.all([
        response(psdUrl, options.signal),
        manifest.overrides
          ? response(resolveManifestUrl(manifest.overrides, manifestUrl), options.signal).then(value => value.json() as Promise<RigOverrides>)
          : Promise.resolve({} as RigOverrides),
      ])
      const buffer = await psdResponse.arrayBuffer()
      options.signal?.throwIfAborted()
      result = await loadRigAsync(this.loader, buffer, psdUrl.split("/").at(-1) ?? `${manifest.id}.psd`, overrides, options.signal)
    }
    const independent = manifest.strategy === "independent-model"
    if (independent && (baseRig.canvas.w !== result.model.rig.canvas.w || baseRig.canvas.h !== result.model.rig.canvas.h)) {
      throw new Error("POSE_ASSET_REGISTRATION_FAILED: independent-model requires matching canvas dimensions")
    }
    const registration = registerPose(independent ? result.model.rig.anchors : baseRig.anchors, result.model.rig.anchors, manifest.registration, {
      base: baseRig.canvas,
      pose: result.model.rig.canvas,
    })
    const selection = independent ? selectIndependentPoseLayers(baseRig, result.model.rig) : selectPoseLayers(baseRig, result.model.rig, manifest.layers)
    const selectedPoseLayers = [...selection.poseReplace, ...selection.poseAdditive]
    for (const selector of Object.keys(manifest.motion?.layers ?? {})) {
      if (!selectedPoseLayers.some((name) => layerMatchesSelector(name, selector))) selection.errors.push(`pose motion layer selector '${selector}' is not selected for rendering`)
    }
    const asset: PoseAsset = {
      manifest,
      manifestUrl,
      sourceUrl,
      result,
      registration,
      selection,
      warnings: [...parsed.warnings, ...result.model.rig.warnings, ...selection.warnings],
    }
    options.signal?.throwIfAborted()
    if (this.cacheBase === baseRig && registration.accepted && !selection.errors.length) {
      if (rigDecodeCacheBytes(asset.result) > 192 * 1024 * 1024) return asset
      this.cache.set(cacheKey, asset)
      // CPU-only LRU. GPU resources are still owned by the single active pose.
      // Include an allowance for compressed source bytes and diagnostic data.
      const size = (item: PoseAsset) => rigDecodeCacheBytes(item.result)
      let bytes = [...this.cache.values()].reduce((sum, item) => sum + size(item), 0)
      while (this.cache.size > 1 && (this.cache.size > 16 || bytes > 192 * 1024 * 1024)) {
        const key = this.cache.keys().next().value!
        bytes -= size(this.cache.get(key)!); this.cache.delete(key)
      }
    }
    return asset
  }
}
