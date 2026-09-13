import { Anime25DRenderer } from '/src/engine/anime25d/Anime25DRenderer.ts'
import { PsdRigLoader } from '/src/engine/anime25d/PsdRigLoader.ts'
import { PoseAssetLoader } from '/src/pose/PoseAssetLoader.ts'
import { DEFAULT_PARAMETERS } from '/src/engine/anime25d/Anime25DParameters.ts'
import { samplePoseMotion } from '/src/pose/PoseMotion.ts'
import { HitAreaResolver } from '/src/interaction/HitAreaResolver.ts'

const json = async url => { const r = await fetch(url); if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json() }
const load = async (psd, overrides) => new PsdRigLoader().loadArrayBuffer(await (await fetch(psd)).arrayBuffer(), psd, overrides)
const renderer = () => { const canvas = document.createElement('canvas'); document.body.append(canvas); return new Anime25DRenderer(canvas) }
const resources = r => ({ meshes: r.meshCount, textures: r.textureCount, buffers: r.bufferCount, framebuffers: r.framebufferCount, renderbuffers: r.renderbufferCount })
const difference = (a, b) => {
  let total = 0, maximum = 0, above8 = 0
  for (let i = 0; i < a.length; i += 4) {
    let pixelMax = 0
    for (let c = 0; c < 4; c++) { const d = Math.abs(a[i+c]-b[i+c]); total += d; maximum = Math.max(maximum, d); pixelMax = Math.max(pixelMax, d) }
    if (pixelMax > 8) above8++
  }
  return { meanRgbaError: total / a.length, maximumChannelError: maximum, pixelsAbove8: above8 }
}

export async function comparePose(source, characterId, entry) {
  const configUrl = source + '/' + entry.model, config = await json(configUrl)
  const relative = path => new URL(path, new URL(configUrl, location.href)).href
  const overrides = await json(relative(config.overrides)), referenceModel = await load(relative(config.psd), overrides)
  referenceModel.model.rig = { ...referenceModel.model.rig, layers: referenceModel.model.rig.layers.filter(layer => !config.excludeAfterMeshResolution.includes(layer.name)) }
  const referencePose = await new PoseAssetLoader().load(relative(config.pose), referenceModel.model.rig)
  const characterUrl = '/characters/' + characterId, character = await json(characterUrl + '/character.json')
  const idleOverrides = await json(characterUrl + '/' + character.base.overrides)
  const idle = await load(characterUrl + '/' + character.base.psd, idleOverrides)
  const appPose = await new PoseAssetLoader().load(characterUrl + '/poses/' + entry.id + '/pose.json', idle.model.rig)
  if (!appPose.registration.accepted || appPose.selection.errors.length || !appPose.selection.independentModel || appPose.selection.baseShared.length) throw new Error('Independent selection failed')
  if (appPose.result.model.rig.layers.some(layer => layer.name.startsWith('arm_mesh_'))) throw new Error('Reference arms entered drawing list')
  if (JSON.stringify(appPose.manifest.motion) !== JSON.stringify(referencePose.manifest.motion)) throw new Error('Imported pose motion changed')
  const reference = renderer(), actual = renderer()
  const report = { pose: entry.id, cases: [], customFrames: 0, maxVertexDifference: 0, screenshots: {},
    registration: appPose.registration, layerCount: appPose.selection.poseReplace.length, sourceAnchors: appPose.result.model.rig.anchors,
    inputAreas: { selected: new HitAreaResolver(referencePose.result.model.rig).areas, app: new HitAreaResolver(appPose.result.model.rig).areas } }
  try {
    reference.applyRig(referenceModel.model.rig); reference.applyPoseRig(referencePose.result.model.rig, referencePose.selection, referencePose.registration.transform); reference.setPoseMix(1)
    actual.applyRig(idle.model.rig); actual.applyPoseRig(appPose.result.model.rig, appPose.selection, appPose.registration.transform); actual.setPoseMix(1)
    const replaced = new Set(referencePose.selection.baseReplace)
    const referenceLayers = [...reference.layers.filter(layer => !replaced.has(layer.name)), ...reference.poseLayers]
    const pairs = actual.poseLayers.map(layer => [layer, referenceLayers.find(candidate => candidate.name === layer.name)])
    if (pairs.some(([a,b]) => !b || a.current.length !== b.current.length)) throw new Error('Render meshes differ')
    const verifyVertices = () => {
      for (const [a,b] of pairs) for (let i=0;i<a.current.length;i++) {
        const delta = Math.abs(a.current[i]-b.current[i]); if (!Number.isFinite(delta)) throw new Error('Invalid vertex')
        report.maxVertexDifference = Math.max(report.maxVertexDifference, delta)
      }
      if (actual.gl.getError() !== actual.gl.NO_ERROR || reference.gl.getError() !== reference.gl.NO_ERROR) throw new Error('WebGL error')
    }
    let now = 100000
    const draw = (parameters, neutral) => { reference.render(parameters, now, neutral); actual.render(parameters, now, neutral); now += 1000/30; verifyVertices() }
    const cases = [{ id: 'neutral', parameters: {} }]
    for (const [label, channels] of [['blink', ['eyeOpenL','eyeOpenR']], ['mouth', ['mouthOpen']], ['smile', ['mouthForm']]]) {
      for (let step=0;step<=10;step++) cases.push({ id: `${label}-${step}`, parameters: Object.fromEntries(channels.map(channel => [channel, step/10])) })
    }
    for (const channel of ['angleX','angleY','angleZ']) for (const value of [-1,1]) cases.push({ id: channel+(value<0?'-minus':'-plus'), parameters: { [channel]: value } })
    for (const condition of cases) {
      draw({ ...DEFAULT_PARAMETERS, ...condition.parameters }, true)
      const metrics = difference(reference.readFrame().data, actual.readFrame().data)
      report.cases.push({ id: condition.id, ...metrics })
      if (['neutral','blink-5','mouth-5','smile-5'].includes(condition.id)) {
        report.screenshots[condition.id+'-reference'] = reference.canvas.toDataURL('image/png')
        report.screenshots[condition.id+'-app'] = actual.canvas.toDataURL('image/png')
      }
    }
    const motion = appPose.manifest.motion
    const duration = motion.playback === 'once' ? Math.max(3000, motion.loopDurationMs+1200) : motion.loopDurationMs
    report.customFrames = Math.ceil(duration*30/1000)
    for (let frame=0;frame<report.customFrames;frame++) {
      const sample = samplePoseMotion(motion, frame*1000/30)
      reference.setPoseLayerTransforms(sample.layers); actual.setPoseLayerTransforms(sample.layers)
      draw({ ...DEFAULT_PARAMETERS, ...sample.parameters }, false)
      if (frame % 30 === 0) await new Promise(requestAnimationFrame)
    }
    if (motion.playback === 'once' && JSON.stringify(samplePoseMotion(motion, motion.loopDurationMs)) !== JSON.stringify(samplePoseMotion(motion, motion.loopDurationMs+2000))) throw new Error('Once motion did not hold')
    report.status = report.maxVertexDifference < .001 && report.cases.every(test => test.meanRgbaError < .02 && test.pixelsAbove8 < 100) ? 'passed' : 'failed'
    return report
  } finally {
    reference.unload(); actual.unload()
    report.resourcesAfterUnload = { reference: resources(reference), app: resources(actual) }
    if (Object.values(report.resourcesAfterUnload).some(values => Object.values(values).some(Boolean))) throw new Error('GPU resources leaked')
    reference.canvas.remove(); actual.canvas.remove()
  }
}

export async function checkModelCrossfade(anchors) {
  if (!anchors) throw new Error('A verified source model is required for compositing checks')
  const solid = (name, color, x, y, w, h, z) => ({ name, x,y,w,h,z,depth:1,group:'body',phys:null,fade:null,side:null,strands:null,
    img:{width:w,height:h,data:Uint8ClampedArray.from(Array.from({length:w*h},()=>color).flat())} })
  const rig = colors => ({ canvas:{w:100,h:100}, warnings:[],synth:{eye:false,mouth:false},anchors,
    layers:[solid('topwear',colors[0],10,10,80,80,0),solid('patch',colors[1],35,35,30,30,1)] })
  const a=rig([[240,20,40,255],[10,220,60,255]]),b=rig([[30,50,230,255],[240,190,20,255]]),r=renderer()
  const select={independentModel:true,baseShared:[],baseReplace:['topwear','patch'],poseReplace:['topwear','patch'],poseAdditive:[],renderBehindBase:[],renderInFrontOfBase:[],errors:[],warnings:[]}
  const transform={scale:1,rotationRad:0,translationX:0,translationY:0,sourceCenterX:0,sourceCenterY:0}
  let maximum=0
  try {
    r.applyRig(a);r.setHairTestMode('off');r.applyPoseRig(b,select,transform)
    const samples=[]
    for(const mix of [0,.25,.5,.75,1]){
      r.setPoseMix(mix);r.render(DEFAULT_PARAMETERS,100000,true)
      const frame=r.readFrame().data
      for(const [x,y,index]of [[20,20,0],[50,50,1]]){
        const pixel=[...frame.slice((y*100+x)*4,(y*100+x)*4+4)]
        const expected=a.layers[index].img.data.slice(0,4).map((value,c)=>Math.round(value*(1-mix)+b.layers[index].img.data[c]*mix))
        for(let c=0;c<4;c++)maximum=Math.max(maximum,Math.abs(pixel[c]-expected[c]))
        samples.push({mix,pixel,expected:[...expected]})
      }
      if(r.gl.getError()!==r.gl.NO_ERROR)throw new Error('Compositor WebGL error')
    }
    const allocated=resources(r);r.unload();const released=resources(r)
    if(maximum>1||Object.values(released).some(Boolean))throw new Error('Full-model compositing failed')
    return {status:'passed',maximumChannelError:maximum,samples,allocated,released}
  }finally{r.unload();r.canvas.remove()}
}
