// Gesture timing is reusable. Pivots, movable regions and contacts belong to the artwork.
import {readFile,writeFile,cp,realpath,mkdir} from 'node:fs/promises'
import {resolve,dirname,relative,join,sep} from 'node:path'
import {pathToFileURL} from 'node:url'
import {parseArgs} from 'node:util'
import {withPackTools} from './pack-tools.mjs'
import {validateConnections,validateLayerReviews} from './attachment-audit.mjs'

const gestures = {
  breathe:{duration:5400,playback:'loop',body:[0,.06,.15,.04,-.1,0],angleZ:[0,-.03,-.09,.02,.07,0]},
  focus:{duration:5600,playback:'loop',body:[0,.04,.10,.10,-.04,0],angleY:[0,.05,-.20,-.12,.04,0],eyeY:[0,0,.25,.25,.05,0]},
  nod:{duration:1800,playback:'once',body:[0,-.06,.18,-.08,.03,0],angleY:[0,.08,-.32,.13,-.04,0]},
  recoil:{duration:2400,playback:'once',body:[0,.08,-.28,.12,-.04,0],angleY:[0,-.04,.28,-.10,.04,0],angleZ:[0,.03,-.14,.08,-.02,0]},
  celebrate:{duration:3200,playback:'loop',body:[0,-.12,.30,-.16,.12,0],angleY:[0,-.08,.23,-.10,.06,0],angleZ:[0,.08,-.20,.17,-.06,0]},
  wave:{duration:2500,playback:'once',body:[0,-.06,.17,-.08,.04,0],angleZ:[0,.06,-.22,.13,-.05,0]},
  look:{duration:6200,playback:'loop',body:[0,-.05,.16,.04,-.13,0],angleX:[0,-.12,-.30,.08,.27,0],angleZ:[0,.04,.12,0,-.10,0],eyeX:[0,-.35,-.35,.1,.35,0]},
  pet:{duration:4200,playback:'loop',body:[0,.03,.10,.03,-.06,0],angleZ:[0,-.05,.21,.08,-.12,0],angleY:[0,.03,.12,.04,-.04,0]},
}
const times=[0,.12,.30,.52,.72,1]
const track=(values,duration,strength=1,lag=0)=>({type:'keyframes',interpolation:'smoothstep',frames:values.map((value,i)=>({atMs:Math.round(duration*(i===0?0:i===5?1:times[i]+lag)),value:value*strength}))})
export function createGestureMotion(plan) {
  const spec=gestures[plan.gesture],strength=plan.strength??1
  if(!spec||!Number.isFinite(strength)||strength<.5||strength>1.5)throw Error('Choose a supported gesture and strength 0.5..1.5')
  const parameters=Object.fromEntries(Object.entries(spec).filter(([,v])=>Array.isArray(v)).map(([k,v])=>[k,track(v,spec.duration,strength)]))
  /** @type {Record<string, import('../../src/pose/types').PoseLayerMotion>} */
  const layers={}
  for(const joint of plan.joints??[]){
    if(!joint.layer||layers[joint.layer]||!joint.origin||!joint.influence)throw Error('Each joint needs a distinct layer, measured origin and influence')
    if(joint.contactLocked)throw Error('Do not move a contact-locked hand independently; author headFollow and verify contact')
    const lag=joint.lag??.06
    if(!Number.isFinite(lag)||lag<0||lag>.15)throw Error('Joint lag must be 0..0.15 of the cycle')
    const values=[0,-.20,1,-.45,.18,0],layer={origin:joint.origin,influence:joint.influence}
    for(const [key,limit] of [['rotationDeg',12],['translateX',40],['translateY',40]])if(joint[key]!==undefined){
      if(!Number.isFinite(joint[key])||Math.abs(joint[key])>limit)throw Error('Joint motion exceeds candidate range: '+key)
      layer[key]=track(values,spec.duration,joint[key]*strength,lag)
    }
    if(Object.keys(layer).length===2)throw Error('Joint needs an authored rotation or translation')
    layers[joint.layer]=layer
  }
  return {loopDurationMs:spec.duration,playback:spec.playback,transition:'continuous',parameters,layers}
}
export async function authorMotion({source,pose:id,round,plan:planFile}) {
  const root=await realpath(source),index=JSON.parse(await readFile(join(root,'models.json'),'utf8')),selected=index.models.find(m=>m.id===id)
  if(!selected||!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(round??''))throw Error('Choose a selected pose and fresh round name')
  const configFile=await realpath(resolve(root,selected.model)),dir=dirname(configFile)
  if(!configFile.startsWith(root+sep))throw Error('Model escapes source run')
  const out=join(dirname(dir),round),config=JSON.parse(await readFile(configFile,'utf8')),manifestFile=resolve(dir,config.pose),manifest=JSON.parse(await readFile(manifestFile,'utf8'))
  const plan=JSON.parse(await readFile(planFile,'utf8'))
  if(!plan.intent?.trim()||!plan.landmarks?.length)throw Error('Record the pose intent and measured motion/contact landmarks')
  for(const mark of plan.landmarks){
    if(!mark.name||!mark.layer||[mark.tip,mark.root,...(mark.targetPoint?[mark.targetPoint]:[])].some(p=>!Array.isArray(p)||p.length!==2||p.some(v=>!Number.isFinite(v))))throw Error('Landmarks need finite source-local coordinates')
    if(mark.minTravelAt320px!==undefined&&(!Number.isFinite(mark.minTravelAt320px)||mark.minTravelAt320px<0))throw Error('Invalid display-size travel target')
  }
  const motion=createGestureMotion(plan)
  validateLayerReviews(plan.joints??[])
  validateConnections(plan.connections??[],Object.keys(motion.layers))
  for (const joint of plan.joints??[]) for (const ref of joint.layerReview.evidence) {
    const evidence=await realpath(resolve(root,ref))
    if(!evidence.startsWith(root+sep))throw Error('Layer review evidence escapes source run')
    await readFile(evidence)
  }
  const candidate={...manifest,motion}
  const jointFrames=await withPackTools(async tools=>{
    tools.initializeCanvas(()=>{throw Error('No canvas required for motion rig inspection')},(width,height)=>({width,height,data:new Uint8ClampedArray(width*height*4),colorSpace:'srgb'}))
    const result=tools.parsePoseManifest(candidate);if(result.warnings.length)throw Error(result.warnings.join('\n'))
    const bytes=await readFile(resolve(dir,config.psd)),overrides=JSON.parse(await readFile(resolve(dir,config.overrides),'utf8'))
    const rig=new tools.PsdRigLoader().loadArrayBuffer(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),id,overrides).model.rig
    for(const name of [...Object.keys(motion.layers),...plan.landmarks.flatMap(m=>[m.layer,...(m.targetLayer?[m.targetLayer]:[])])])if(!rig.layers.some(l=>l.name===name))throw Error('Unknown runtime layer (use capture diagnostics): '+name)
    validateConnections(plan.connections??[],Object.keys(motion.layers),rig.layers)
    return rig.layers.filter(l=>Object.hasOwn(motion.layers,l.name)).map(({name,x,y,w,h})=>({name,x,y,w,h}))
  })
  await mkdir(out) // Never overwrite an accepted or rejected round.
  await cp(dir,out,{recursive:true})
  const rebase=(ref,base)=>{const absolute=resolve(base,ref);return relative(out,absolute.startsWith(dir+sep)?resolve(out,relative(dir,absolute)):absolute).split(sep).join('/')}
  for(const key of ['bodySource','psd','overrides','pose'])if(config[key])config[key]=rebase(config[key],dir)
  for(const key of ['source','psd','overrides'])if(candidate[key])candidate[key]=rebase(candidate[key],dirname(manifestFile))
  config.pose='pose.json'
  await writeFile(join(out,'pose.json'),JSON.stringify(candidate,null,2)+'\n')
  await writeFile(join(out,'model.json'),JSON.stringify(config,null,2)+'\n')
  await writeFile(join(out,'motion-authorship.json'),JSON.stringify({...plan,jointFrames,pose:id,status:'candidate_pending_motion_and_contact_review',beats:['prepare','action','overshoot','settle'],sourceModel:selected.model},null,2)+'\n')
  return {model:relative(root,join(out,'model.json')),selected:false,next:'Select this new model in models.json, capture --motion --contacts and review at display size before acceptance'}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const {values}=parseArgs({options:Object.fromEntries(['source','pose','round','plan'].map(k=>[k,{type:'string'}]))})
  console.log(JSON.stringify(await authorMotion(values),null,2))
}
