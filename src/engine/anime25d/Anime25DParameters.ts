import type { Anime25DParameter, Anime25DParameterState } from "./types"

export const DEFAULT_PARAMETERS: Anime25DParameterState = {
  angleX: 0, angleY: 0, angleZ: 0,
  eyeOpenL: 1, eyeOpenR: 1, eyeX: 0, eyeY: 0, irisScale: 1,
  brow: 0, browAngL: 0, browAngR: 0, browAngSym: 0,
  mouthOpen: 0, mouthForm: 0, mouthCY: 0,
  body: 0, armY: 0, armPos: 0,
  physAmp: 2, soft: 2, bust: 2.5, bustY: 1,
  bangL: 0, bangC: 0, bangR: 0, fhAmp: 2, fhSoft: 0.4,
  eyeEase: 0.3, mouthEase: 0.45, eyeCY: 0, eyeCAng: 0, mouthCAng: 0,
  eyeScaleL: 1, eyeScaleR: 1, mouthScale: 1,
}

export const PARAMETER_RANGES: Record<Anime25DParameter, readonly [number, number]> = {
  angleX: [-1, 1], angleY: [-1, 1], angleZ: [-1, 1],
  eyeOpenL: [0, 1], eyeOpenR: [0, 1], eyeX: [-1, 1], eyeY: [-1, 1], irisScale: [0.5, 1.3],
  brow: [-1, 1], browAngL: [-1, 1], browAngR: [-1, 1], browAngSym: [-1, 1],
  mouthOpen: [0, 1], mouthForm: [-1, 1], mouthCY: [-1, 1],
  body: [-1, 1], armY: [-1, 1], armPos: [-1, 1],
  physAmp: [0, 3], soft: [0, 3], bust: [0, 4], bustY: [-3, 3],
  bangL: [-1, 1], bangC: [-1, 1], bangR: [-1, 1], fhAmp: [0, 3], fhSoft: [0, 2],
  eyeEase: [0, 1], mouthEase: [0, 1], eyeCY: [-1, 1], eyeCAng: [-1, 1], mouthCAng: [-1, 1],
  eyeScaleL: [0.5, 1.5], eyeScaleR: [0.5, 1.5], mouthScale: [0.5, 1.5],
}

export function clampParameter(name: Anime25DParameter, value: number): number {
  const [min, max] = PARAMETER_RANGES[name]
  return Math.max(min, Math.min(max, value))
}
