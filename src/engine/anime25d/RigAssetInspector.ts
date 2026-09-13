import type { Layer, Psd } from "ag-psd"
import type { Bounds, PsdCompositeLayer, RigAssetDiagnostics, RigDefinition, RigImage, RigLayerInspection, RigQualityFinding } from "./types"

export function clonePsd(psd: Psd): Psd {
  const cloneLayer = (layer: Layer): Layer => ({
    ...layer,
    imageData: layer.imageData ? {
      width: layer.imageData.width,
      height: layer.imageData.height,
      data: new Uint8ClampedArray(layer.imageData.data),
    } : undefined,
    children: layer.children?.map(cloneLayer),
  })
  return {
    ...psd,
    imageData: psd.imageData ? {
      width: psd.imageData.width,
      height: psd.imageData.height,
      data: new Uint8ClampedArray(psd.imageData.data),
    } : undefined,
    children: psd.children?.map(cloneLayer),
  }
}

export function alphaPixelCount(layer: Layer): number {
  const data = layer.imageData?.data
  if (!data) return 0
  let count = 0
  for (let index = 3; index < data.length; index += 4) if (data[index]) count++
  return count
}

export function layerBounds(layer: Layer): Bounds {
  const left = layer.left ?? 0
  const top = layer.top ?? 0
  const width = layer.imageData?.width ?? Math.max(0, (layer.right ?? left) - left)
  const height = layer.imageData?.height ?? Math.max(0, (layer.bottom ?? top) - top)
  return { x0: left, y0: top, x1: left + width, y1: top + height }
}

export function compositeLayers(width: number, height: number, layers: Layer[]): RigImage {
  const output = new Uint8ClampedArray(width * height * 4)
  for (const layer of layers) {
    if (layer.hidden || !layer.imageData) continue
    const { data, width: layerWidth, height: layerHeight } = layer.imageData
    const left = layer.left ?? 0
    const top = layer.top ?? 0
    const opacity = layer.opacity ?? 1
    for (let sy = 0; sy < layerHeight; sy++) for (let sx = 0; sx < layerWidth; sx++) {
      const dx = left + sx
      const dy = top + sy
      if (dx < 0 || dy < 0 || dx >= width || dy >= height) continue
      const sourceIndex = (sy * layerWidth + sx) * 4
      const destIndex = (dy * width + dx) * 4
      const sourceAlpha = data[sourceIndex + 3] / 255 * opacity
      if (!sourceAlpha) continue
      const destAlpha = output[destIndex + 3] / 255
      const resultAlpha = sourceAlpha + destAlpha * (1 - sourceAlpha)
      for (let channel = 0; channel < 3; channel++) {
        output[destIndex + channel] = Math.round((data[sourceIndex + channel] * sourceAlpha + output[destIndex + channel] * destAlpha * (1 - sourceAlpha)) / resultAlpha)
      }
      output[destIndex + 3] = Math.round(resultAlpha * 255)
    }
  }
  return { width, height, data: output }
}

export function toCompositeLayer(name: string, layer: Layer, visible = true): PsdCompositeLayer {
  const data = layer.imageData?.data ?? new Uint8ClampedArray(0)
  return {
    name,
    x: layer.left ?? 0,
    y: layer.top ?? 0,
    visible,
    img: {
      width: layer.imageData?.width ?? 0,
      height: layer.imageData?.height ?? 0,
      data: new Uint8ClampedArray(data),
    },
  }
}

export function compositeStoredLayers(width: number, height: number, layers: PsdCompositeLayer[]): RigImage {
  const psdLayers: Layer[] = layers.filter((layer) => layer.visible).map((layer) => ({
    name: layer.name,
    left: layer.x,
    top: layer.y,
    right: layer.x + layer.img.width,
    bottom: layer.y + layer.img.height,
    imageData: { width: layer.img.width, height: layer.img.height, data: layer.img.data },
  }))
  return compositeLayers(width, height, psdLayers)
}

export function qualityFindings(layers: RigLayerInspection[], rig: RigDefinition): RigQualityFinding[] {
  const findings: RigQualityFinding[] = []
  const neck = layers.find((layer) => layer.visible && layer.normalizedName === "neck")
  if (!neck) findings.push({ code: "NECK_MISSING", severity: "error", message: "PSD에 neck 레이어가 없습니다." })
  else if (!neck.alphaAfter) findings.push({ code: "NECK_EMPTY_AFTER_CLEANUP", severity: "error", message: "cleanup 후 neck 레이어가 비었습니다.", layer: neck.name })
  else if (neck.alphaAfter / Math.max(1, neck.alphaBefore) < 0.9) findings.push({ code: "NECK_ALPHA_LOSS", severity: "warning", message: "cleanup에서 neck 알파 픽셀이 10% 이상 손실됐습니다.", layer: neck.name })

  for (const name of ["eyewhite", "irides", "eyelash"]) {
    if (!layers.some((layer) => layer.visible && layer.normalizedName.startsWith(name))) findings.push({ code: `EYE_${name.toUpperCase()}_MISSING`, severity: "error", message: `${name} 레이어가 없습니다.` })
  }
  if (!layers.some((layer) => layer.visible && layer.normalizedName.startsWith("eye_close"))) {
    findings.push({ code: "EYE_CLOSE_SYNTHETIC", severity: "warning", message: "전용 eye_close가 없어 generic 닫힌 눈 파츠를 사용합니다." })
  }
  if (rig.layers.some((layer) => layer.name.startsWith("eye_skin_patch"))) {
    findings.push({ code: "FACE_EYE_RESIDUAL_REPAIRED", severity: "info", message: "face에 섞인 open-eye 픽셀을 blink 전용 보간 skin patch로 보정합니다.", layer: "face" })
  }
  if (rig.layers.filter((layer) => layer.phys === "hair").some((layer) => (layer.strands?.length ?? 0) < 2)) {
    findings.push({ code: "HAIR_STRANDS_LOW", severity: "warning", message: "strand가 2개 미만인 hair 레이어가 있습니다." })
  }
  return findings
}

export function createAssetDiagnostics(
  source: string,
  canvas: [number, number],
  rawLayers: RigLayerInspection[],
  cleanedLayers: RigLayerInspection[],
  rig: RigDefinition,
): RigAssetDiagnostics {
  return {
    source,
    canvas,
    rawLayers,
    cleanedLayers,
    rigLayers: rig.layers.map((layer) => ({
      name: layer.name, x: layer.x, y: layer.y, w: layer.w, h: layer.h, z: layer.z,
      depth: layer.depth, group: layer.group, fade: layer.fade, side: layer.side,
      hairStrands: layer.strands?.length ?? 0,
    })),
    anchors: rig.anchors,
    warnings: [...rig.warnings],
    qualityFindings: qualityFindings(cleanedLayers, rig),
  }
}
