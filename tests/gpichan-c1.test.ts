import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { initializeCanvas } from 'ag-psd'
import { describe, expect, it } from 'vitest'
import { PsdRigLoader } from '../src/engine/anime25d/PsdRigLoader'
import type { RigImage } from '../src/engine/anime25d/types'
import { parseCatalogManifest, parseCharacterManifest, parsePoseManifest } from '../src/pose/PoseManifest'
import { registerPose } from '../src/pose/PoseRegistration'
import { selectPoseLayers } from '../src/pose/PoseLayerSelector'
import { samplePoseMotion } from '../src/pose/PoseMotion'
import { parseBehaviorManifest, validateBehaviorPoseIds } from '../src/behavior/BehaviorManifest'
import { constrainPoseRenderSlot } from '../src/engine/anime25d/Anime25DRenderer'

initializeCanvas(
  (() => { throw new Error('No canvas in asset contract tests') }) as unknown as (width: number, height: number) => HTMLCanvasElement,
  (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4), colorSpace: 'srgb' }) as ImageData,
)
const root = 'public/characters/gpichan'
const path = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url))
const bytes = (p: string) => readFileSync(path(p))
const json = (p: string) => JSON.parse(bytes(p).toString('utf8'))
function expectSamePixels(actual: RigImage, expected: RigImage, label: string) {
  expect([actual.width, actual.height, actual.data.byteLength], label).toEqual([expected.width, expected.height, expected.data.byteLength])
  const view = (data: Uint8ClampedArray) => Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  expect(view(actual.data).equals(view(expected.data)), `${label} pixels`).toBe(true)
}
function rig(psd: string, overrides: string) {
  const data = bytes(psd)
  return new PsdRigLoader().loadArrayBuffer(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer, psd, json(overrides)).model
}
const baseFiles = json(root + '/character.json').base
const base = rig(root + '/' + baseFiles.psd, root + '/' + baseFiles.overrides)

describe('Gpichan C1 authoring package', () => {
  it('adds C2 head-pet with shared Base pixels, registered anchors and linked foreground deformation', () => {
    const dir=`${root}/poses/head-pet`,manifest=parsePoseManifest(json(`${dir}/pose.json`)).value
    const model=rig(`${dir}/${manifest.psd}`,`${dir}/${manifest.overrides}`)
    expect(registerPose(base.rig.anchors,model.rig.anchors,manifest.registration,{base:base.rig.canvas,pose:model.rig.canvas}).accepted).toBe(true)
    expect(model.rig.anchors).toEqual(base.rig.anchors)
    const selection=selectPoseLayers(base.rig,model.rig,manifest.layers)
    expect(selection.errors).toEqual([])
    expect(selection.baseReplace).toEqual(['handwear_1','handwear_2'])
    for(const layer of base.rig.layers.filter(layer=>!layer.name.startsWith('handwear'))){
      expectSamePixels(model.rig.layers.find(copy=>copy.name===layer.name)!.img,layer.img,`head-pet/${layer.name}`)
    }
    for(const name of [...selection.poseReplace,...selection.poseAdditive]){
      const layer=model.rig.layers.find(layer=>layer.name===name)!
      let opaque=0,green=0
      for(let i=0;i<layer.img.data.length;i+=4){const data=layer.img.data;if(data[i+3]>16){opaque++;if(data[i+1]-Math.max(data[i],data[i+2])>30)green++}}
      expect(opaque,name).toBeGreaterThan(100)
      expect(opaque,name).toBeLessThan(1280*1280*.25)
      expect(green,name).toBe(0)
    }
    for(const side of [1,2]){
      const arm=model.rig.layers.find(layer=>layer.name===`handwear_${side}`)!
      const front=model.rig.layers.find(layer=>layer.name===`forearm_${side}`)!
      expect(front.deformationSource).toBe(arm.name)
      expect([front.x,front.y,front.w,front.h]).toEqual([arm.x,arm.y,arm.w,arm.h])
      expect(manifest.motion!.layers[front.name]).toEqual(manifest.motion!.layers[arm.name])
    }
    const original=['writing','waiting','failed','cancelled','disconnected','bored','happy','head-tap','torso-tap']
    expect(json(`${root}/character.json`).poses).toEqual([...original,'head-pet'].map(id=>`poses/${id}/pose.json`))
  }, 10000)

  it('registers all eight chosen poses with unchanged identity anchors and valid alpha', () => {
    const ids = ['waiting', 'failed', 'cancelled', 'disconnected', 'bored', 'happy', 'head-tap', 'torso-tap']
    for (const id of ids) {
      const dir = `${root}/poses/${id}`
      const manifest = parsePoseManifest(json(`${dir}/pose.json`)).value
      const model = rig(`${dir}/${manifest.psd}`, `${dir}/${manifest.overrides}`)
      const registration = registerPose(base.rig.anchors, model.rig.anchors, manifest.registration, { base: base.rig.canvas, pose: model.rig.canvas })
      expect(registration.accepted, id).toBe(true)
      expect(model.rig.anchors, id).toEqual(base.rig.anchors)
      const selection = selectPoseLayers(base.rig, model.rig, manifest.layers)
      expect(selection.errors, id).toEqual([])
      // Verify the combined Base/Pose draw order, not only each PSD's local z.
      // The hood includes the turtleneck and must never cover the visible neck.
      const baseSlots = base.rig.layers.map((layer, renderSlot) => ({ name: layer.name, renderSlot }))
      const poseMaxZ = Math.max(...model.rig.layers.map(layer => layer.z))
      const renderSlot = (name: string) => {
        const layer = model.rig.layers.find(layer => layer.name === name)!
        return constrainPoseRenderSlot(name, layer.z / poseMaxZ * (baseSlots.length - 1) + .01, baseSlots, selection.renderBehindBase, selection.renderInFrontOfBase)
      }
      if (['cancelled', 'bored', 'head-tap', 'torso-tap'].includes(id)) {
        const topwearSlot = baseSlots.find(layer => layer.name === 'topwear')!.renderSlot
        for (const name of selection.poseReplace) expect(renderSlot(name), `${id}: shoulder behind Base jacket`).toBeLessThan(topwearSlot)
        expect(selection.poseAdditive).toEqual(id === 'head-tap' ? ['forearm_2'] : ['forearm_2', 'forearm_1'])
        for (const name of selection.poseAdditive) expect(renderSlot(name), `${id}: hand/prop in front of jacket`).toBeGreaterThan(topwearSlot)
      } else {
        expect(renderSlot('pose_hood'), `${id}: collar must stay behind visible neck`).toBeLessThan(baseSlots.find(layer => layer.name === 'neck_2')!.renderSlot)
        for (const name of selection.poseReplace) expect(renderSlot(name), `${id}: sleeve below hood`).toBeLessThan(renderSlot('pose_hood'))
      }
      expect(selection.baseReplace, id).toEqual(id === 'head-tap' ? ['handwear_2'] : ['handwear_1', 'handwear_2'])
      for (const layer of base.rig.layers.filter(l => !l.name.startsWith('handwear') && (!l.mouthExpression || l.mouthExpression === 'neutral'))) {
        expectSamePixels(model.rig.layers.find(l => l.name === layer.name)!.img, layer.img, `${id}/${layer.name}`)
      }
      for (const name of [...selection.poseReplace, ...selection.poseAdditive]) {
        const layer = model.rig.layers.find(l => l.name === name)!
        let opaque = 0, green = 0
        const data = layer.img.data
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] > 16) { opaque++; if (data[i + 1] - Math.max(data[i], data[i + 2]) > 30) green++ }
        }
        expect(opaque, `${id}/${name}`).toBeGreaterThan(100)
        expect(green, `${id}/${name} chroma spill`).toBe(0)
      }
    }
    const behavior = parseBehaviorManifest(json(`${root}/behavior.json`)).value
    expect(base.rig.layers.filter(layer => layer.mouthExpression).map(layer => layer.mouthExpression).sort()).toEqual(['neutral','open','smile'])
    for (const layer of base.rig.layers.filter(layer => layer.mouthExpression)) expect(layer.img.data.some((value,index)=>index%4===3&&value>16),layer.name).toBe(true)
    expect(validateBehaviorPoseIds({ ...behavior, sourceUrl:null, warnings:[], usedDefault:false }, ['writing', ...ids, 'head-pet'])).toEqual([])
    expect(behavior.states.WAITING?.poseId).toBe('waiting')
    expect(behavior.states.BORED.poseId).toBe('bored')
    expect(behavior.states.HAPPY.poseId).toBe('happy')
    expect(behavior.disconnected?.poseId).toBe('disconnected')
    expect([behavior.failureReaction?.poseId, behavior.cancellationReaction?.poseId, behavior.interactionReactions?.HEAD_TAP?.poseId, behavior.interactionReactions?.TORSO_TAP?.poseId]).toEqual(['failed', 'cancelled', 'head-tap', 'torso-tap'])
  }, 30_000)

  it('preserves the supplied original and keeps Gpichan first in the active catalogs', () => {
    const stable = parseCatalogManifest(json('public/characters/catalog.json')).value
    expect(stable.characters).toEqual(['gpichan/character.json'])
    const manifest = parseCharacterManifest(json(root + '/character.json')).value
    expect(manifest).toMatchObject({ id: 'gpichan', label: '지피쨩' })
    expect(manifest.poses).toHaveLength(10)
    expect(manifest.poses).toContain('poses/writing/pose.json')
    for (const relative of [manifest.base.source, manifest.base.psd, manifest.base.overrides!, ...manifest.poses]) {
      expect(existsSync(path(root + '/' + relative)), relative).toBe(true)
    }
  })

  it('keeps a valid independent face, both eyes, mouth and visible neck', () => {
    expect(base.missingRequiredLayers).toEqual([])
    expect(base.rig.canvas).toEqual({ w: 1280, h: 1280 })
    const z = (name: string) => base.rig.layers.find(l => l.name === name)!.z
    expect(z('neck')).toBeLessThan(z('topwear'))
    expect(z('topwear')).toBeLessThan(z('neck_2'))
    expect(z('neck_2')).toBeLessThan(z('face'))
    const neck = base.rig.layers.find(layer => layer.name === 'neck')!
    const visibleNeck = base.rig.layers.find(layer => layer.name === 'neck_2')!
    const alphaAt = (x: number, y: number) => visibleNeck.img.data[((y - visibleNeck.y) * visibleNeck.img.width + x - visibleNeck.x) * 4 + 3]
    expect(neck.deformationSource).toBe('topwear')
    expect(visibleNeck.deformationSource).toBe('topwear')
    expect(alphaAt(614, 333), 'left neck contour must not have a square notch').toBeGreaterThan(200)
    expect(alphaAt(689, 333), 'right neck contour must not have a square notch').toBeGreaterThan(200)
    expect(alphaAt(650, 358), 'skin must stop above the front collar seam').toBe(0)
    expect(base.rig.anchors.eyeL).toBeDefined()
    expect(base.rig.anchors.eyeR).toBeDefined()
    expect(base.rig.anchors.eyeL!.icx).toBeLessThan(base.rig.anchors.eyeR!.icx)
    expect(base.rig.synth.mouth).toBe(false)
    for (const name of ['face', 'irides_l', 'irides_r', 'neck_2']) {
      expect(base.rig.layers.find(l => l.name === name)?.img.data.some((v, i) => i % 4 === 3 && v > 0), name).toBe(true)
    }
  })

  it('registers the selected writing pose without relaxing tolerance or swapping identity layers', () => {
    const manifest = parsePoseManifest(json(root + '/poses/writing/pose.json')).value
    const pose = rig(root + '/poses/writing/' + manifest.psd, root + '/poses/writing/' + manifest.overrides)
    const registration = registerPose(base.rig.anchors, pose.rig.anchors, manifest.registration, { base: base.rig.canvas, pose: pose.rig.canvas })
    expect(registration.accepted, registration.reasons.join('; ')).toBe(true)
    expect(pose.rig.anchors).toEqual(base.rig.anchors)
    expect(manifest.registration).toEqual({ strategy: 'eyes-and-neck', maxScaleDelta: .06, maxRotationDeg: 3, maxAnchorErrorPx: 15 })
    const selection = selectPoseLayers(base.rig, pose.rig, manifest.layers)
    expect(selection.errors).toEqual([])
    expect(selection.baseReplace).toEqual(['handwear_1', 'handwear_2'])
    expect(selection.baseShared).toEqual(expect.arrayContaining(['face', 'neck', 'neck_2', 'irides_l', 'irides_r']))
    for (const name of ['face', 'neck', 'neck_2', 'irides_l', 'irides_r', 'front hair', 'back hair', 'topwear']) {
      expectSamePixels(pose.rig.layers.find(l => l.name === name)!.img, base.rig.layers.find(l => l.name === name)!.img, name)
    }
    for (const name of [...selection.poseReplace, ...selection.poseAdditive]) {
      const layer = pose.rig.layers.find(l => l.name === name)!
      expect(layer.group, name).not.toBe('head')
      let alphaPixels = 0, greenPixels = 0
      const data = layer.img.data
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] > 16) { alphaPixels++; if (data[i + 1] - Math.max(data[i], data[i + 2]) > 30) greenPixels++ }
      }
      expect(alphaPixels, name).toBeGreaterThan(100)
      expect(alphaPixels, `${name} must not contain an opaque full-canvas matte`).toBeLessThan(1280 * 1280 * .25)
      expect(greenPixels, `${name} chroma spill`).toBe(0)
    }
  }, 10_000)

  it('moves the writing hand and foreground copy together throughout the authored loop', () => {
    const manifest = parsePoseManifest(json(root + '/poses/writing/pose.json')).value
    expect(manifest.motion?.transition).toBe('continuous')
    for (let at = 0; at <= 1680; at += 35) {
      const sample = samplePoseMotion(manifest.motion!, at)
      expect(sample.layers.handwear_2).toEqual(sample.layers.forearm_2)
    }
    const behavior = json(root + '/behavior.json')
    expect(behavior.states.BUSY.poseId).toBe('writing')
  })
})
