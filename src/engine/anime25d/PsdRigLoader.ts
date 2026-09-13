import { readPsd, type Layer, type Psd } from "ag-psd"
import "./upstream/rigger.js"
import "./upstream/genericparts.js"
import { applyRigOverrides, aliasLayerName, cleanupThresholdFor, type RigOverrides } from "./RigOverrides"
import { alphaPixelCount, clonePsd, compositeLayers, createAssetDiagnostics, layerBounds, toCompositeLayer } from "./RigAssetInspector"
import type { Anime25DModelData, PsdLayerDiagnostic, RigAssetDiagnostics, RigImage, RigLayerInspection, RigLoadResult } from "./types"

const REQUIRED = ["face", "eyewhite", "irides", "eyelash"] as const
const PRE_SPLIT_EYES = /^(eyewhite|irides|eyelash|eyebrow|eye_close)[-_](l|r)$/
const PRE_SPLIT_BODY = /^(handwear|ears)[-_](l|r)$/

type FlatLayer = { layer: Layer; name: string; path: string; hidden: boolean; order: number }

function rigger() {
  if (!globalThis.Rigger) throw new Error("Anime2.5DRig Rigger failed to initialize")
  return globalThis.Rigger
}

function flattenLayers(children: Layer[] | undefined, parentPath = "", inheritedHidden = false, output: FlatLayer[] = []): FlatLayer[] {
  for (const child of children ?? []) {
    const name = child.name || "unnamed"
    const path = parentPath ? `${parentPath}/${name}` : name
    const hidden = inheritedHidden || child.hidden === true
    if (child.children?.length) {
      flattenLayers(child.children, path, hidden, output)
      continue
    }
    if (!child.imageData) continue
    output.push({ layer: child, name, path, hidden, order: output.length })
  }
  return output
}

function cloneLayer(layer: Layer): Layer {
  return {
    ...layer,
    imageData: layer.imageData ? {
      width: layer.imageData.width,
      height: layer.imageData.height,
      data: new Uint8ClampedArray(layer.imageData.data),
    } : undefined,
    children: layer.children?.map(cloneLayer),
  }
}

function riggerLayerName(name: string): string {
  const normalized = rigger().normName(name)
  const eye = normalized.match(PRE_SPLIT_EYES)
  if (eye) return eye[1]
  const body = normalized.match(PRE_SPLIT_BODY)
  if (body) return `${body[1]}_${body[2] === "l" ? 1 : 2}`
  return normalized
}

function missingLayers(names: string[]): string[] {
  const normalized = names.map((name) => rigger().baseName(riggerLayerName(name)))
  const missing = REQUIRED.filter((name) => !normalized.includes(name)) as string[]
  if (!normalized.includes("front hair") && !normalized.includes("back hair")) missing.push("front hair | back hair")
  if (!normalized.includes("topwear") && !normalized.some((name) => name.includes("body"))) missing.push("topwear | body")
  return missing
}

function inspectionFor(records: FlatLayer[], cleaned: Array<Layer | undefined>, rigLayers: Anime25DModelData["rig"]["layers"], overrides: RigOverrides): RigLayerInspection[] {
  const hidden = new Set((overrides.hiddenLayers ?? []).map((name) => rigger().normName(name)))
  return records.map((record, index) => {
    const alias = aliasLayerName(record.name, overrides)
    const canonical = riggerLayerName(alias)
    const cleanLayer = cleaned[index]
    const sourceBounds = cleanLayer ? layerBounds(cleanLayer) : layerBounds(record.layer)
    const matches = rigLayers.filter((layer) => {
      if (layer.name !== canonical && !layer.name.startsWith(`${canonical}_`)) return false
      return layer.x < sourceBounds.x1 && layer.x + layer.w > sourceBounds.x0 && layer.y < sourceBounds.y1 && layer.y + layer.h > sourceBounds.y0
    })
    return {
      id: `${index}:${canonical}`,
      name: record.name,
      normalizedName: matches.length === 1 ? matches[0].name : canonical,
      path: record.path,
      order: index,
      visible: !record.hidden && !hidden.has(rigger().normName(record.name)),
      group: [...new Set(matches.map((layer) => layer.group))].join("/") || "unmapped",
      bounds: sourceBounds,
      alphaBefore: alphaPixelCount(record.layer),
      alphaAfter: cleanLayer ? alphaPixelCount(cleanLayer) : 0,
      fade: matches.find((layer) => layer.fade)?.fade ?? null,
      side: [...new Set(matches.map((layer) => layer.side).filter(Boolean))].join("/") || "—",
      hairStrands: matches.reduce((count, layer) => count + (layer.strands?.length ?? 0), 0),
    }
  })
}

function splitBackHairForRig(psd: Psd, overrides: RigOverrides): Psd {
  if (!overrides.hairSplit?.backHairLeftRight) return psd
  const children = psd.children ?? []
  const face = children.find((layer) => rigger().baseName(rigger().normName(layer.name || "")) === "face")
  const centerX = overrides.hairSplit.centerX ?? ((face?.left ?? psd.width * 0.4) + (face?.right ?? psd.width * 0.6)) / 2
  const split: Layer[] = []
  for (const layer of children) {
    if (rigger().baseName(rigger().normName(layer.name || "")) !== "back hair" || !layer.imageData) {
      split.push(layer)
      continue
    }
    const makeSide = (side: 1 | 2) => {
      const copy = cloneLayer(layer)
      const image = copy.imageData as NonNullable<Layer["imageData"]>
      const left = copy.left ?? 0
      for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
        const globalX = left + x
        if ((side === 1 && globalX > centerX) || (side === 2 && globalX <= centerX)) image.data[(y * image.width + x) * 4 + 3] = 0
      }
      copy.name = `back hair_${side}`
      return copy
    }
    split.push(makeSide(1), makeSide(2))
  }
  return { ...psd, children: split }
}

export class PsdRigLoader {
  async load(file: File, overrides: RigOverrides = {}): Promise<RigLoadResult> {
    return this.loadArrayBuffer(await file.arrayBuffer(), file.name, overrides)
  }

  loadArrayBuffer(buffer: ArrayBuffer, sourceName = "character.psd", overrides: RigOverrides = {}): RigLoadResult {
    const parsed = readPsd(buffer, { useImageData: true, skipThumbnail: true, skipCompositeImageData: true })
    return this.build(parsed, sourceName, overrides)
  }

  build(parsed: Psd, sourceName = "character.psd", overrides: RigOverrides = {}): RigLoadResult {
    const rawPsd = clonePsd(parsed)
    const rawRecords = flattenLayers(rawPsd.children)
    if (!rawRecords.length) throw new Error("PSD에 렌더링 가능한 픽셀 레이어가 없습니다.")

    const hidden = new Set((overrides.hiddenLayers ?? []).map((name) => rigger().normName(name)))
    const adapterRecords = rawRecords.filter((record) => !record.hidden && !hidden.has(rigger().normName(record.name)))

    // Source diagnostics remain untouched; only this cloned adapter PSD is
    // canonicalized for the pinned Anime2.5DRig boundary.
    const normalizedPsd: Psd = {
      ...rawPsd,
      children: adapterRecords.map((record) => ({
        ...cloneLayer(record.layer),
        name: riggerLayerName(aliasLayerName(record.name, overrides)),
      })),
    }
    const cleanupThresholds = Object.fromEntries(adapterRecords.map((record) => [
      riggerLayerName(aliasLayerName(record.name, overrides)),
      cleanupThresholdFor(aliasLayerName(record.name, overrides), overrides),
    ]))
    const preprocessing = rigger().cleanPsdLayers(normalizedPsd, { cleanupThresholds })
    const cleanedLayers = (normalizedPsd.children ?? []).filter((layer) => layer.imageData)

    const generic = globalThis.GenericParts
    const rigPsd = splitBackHairForRig(clonePsd(normalizedPsd), overrides)
    const built = rigger().buildRig(rigPsd, {
      cleanupThresholds,
      generic: generic ? {
        eyeL: generic.get("eyeL") ?? undefined,
        eyeR: generic.get("eyeR") ?? undefined,
        mouth: generic.get("mouth") ?? undefined,
      } : undefined,
    })
    const rig = applyRigOverrides(built, overrides)

    const psdLayers: PsdLayerDiagnostic[] = rawRecords.map((record) => ({
      name: record.name,
      normalizedName: rigger().normName(aliasLayerName(record.name, overrides)),
      order: record.order,
      visible: !record.hidden,
      path: record.path,
    }))
    const missingRequiredLayers = missingLayers(adapterRecords.map((record) => aliasLayerName(record.name, overrides)))
    // Runtime rendering and pack verification only need the rig. Full-canvas
    // authoring comparisons are expensive and should be built when inspected.
    let rawComposite: RigImage | undefined, cleanedComposite: RigImage | undefined
    let rawCompositeLayers: Anime25DModelData["rawCompositeLayers"] | undefined
    let cleanedCompositeLayers: Anime25DModelData["cleanedCompositeLayers"] | undefined
    let assetDiagnostics: RigAssetDiagnostics | undefined
    const model: Anime25DModelData = {
      sourceName,
      rig,
      psdLayers,
      missingRequiredLayers,
      get rawComposite() { return rawComposite ??= compositeLayers(rawPsd.width, rawPsd.height, rawRecords.filter(record => !record.hidden).map(record => record.layer)) },
      get cleanedComposite() { return cleanedComposite ??= compositeLayers(normalizedPsd.width, normalizedPsd.height, cleanedLayers) },
      get rawCompositeLayers() { return rawCompositeLayers ??= rawRecords.map(record => toCompositeLayer(record.name, record.layer, !record.hidden)) },
      get cleanedCompositeLayers() { return cleanedCompositeLayers ??= cleanedLayers.map((layer, index) => toCompositeLayer(adapterRecords[index].name, layer, true)) },
      get assetDiagnostics() {
        if (!assetDiagnostics) {
          const cleanedByRecord = new Map(adapterRecords.map((record, index) => [record, cleanedLayers[index]]))
          const cleanedInspection = inspectionFor(rawRecords, rawRecords.map(record => cleanedByRecord.get(record)), rig.layers, overrides)
          const rawInspection = cleanedInspection.map((inspection, index) => ({ ...inspection, bounds: layerBounds(rawRecords[index].layer), alphaAfter: inspection.alphaBefore }))
          assetDiagnostics = createAssetDiagnostics(sourceName, [rig.canvas.w, rig.canvas.h], rawInspection, cleanedInspection, rig)
        }
        return assetDiagnostics
      },
    }
    return { model, preprocessing }
  }
}
