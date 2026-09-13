import type { RigDefinition } from "../types"

type PsdLike = { width: number; height: number; children?: unknown[] }
type GenericImage = { width: number; height: number; data: Uint8ClampedArray }

interface Anime25DRigger {
  buildRig(psd: PsdLike, options?: { cleanupThresholds?: Record<string, number>; generic?: { eyeL?: GenericImage; eyeR?: GenericImage; mouth?: GenericImage } }): RigDefinition
  cleanPsdLayers(psd: PsdLike, options?: { cleanupThresholds?: Record<string, number> }): { noisy: number; layers: number }
  normName(name: string): string
  baseName(name: string): string
  flattenPsdToImg(psd: PsdLike): GenericImage | null
  splitImgLR(image: GenericImage): { l: GenericImage; r: GenericImage } | null
}

interface Anime25DGenericParts {
  get(name: "eyeL" | "eyeR" | "mouth"): GenericImage | null
}

declare global {
  var Rigger: Anime25DRigger | undefined
  var GenericParts: Anime25DGenericParts | undefined
}

export {}
