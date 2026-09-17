import {expect,it} from 'vitest'
import {createGestureMotion,authorMotion} from '../scripts/characters/author-motion.mjs'
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {tinyPsd} from './helpers/character-pack'
import {auditEyeMeshes} from '../scripts/characters/mesh-audit.mjs'
import {samplePoseMotion} from '../src/pose/PoseMotion'
import {parsePoseManifest} from '../src/pose/PoseManifest'
const manifest={schemaVersion:1,id:'fixture',label:'Fixture',source:'source.png',psd:'model.psd',strategy:'independent-model',registration:{strategy:'identity',maxScaleDelta:0,maxRotationDeg:0,maxAnchorErrorPx:0},layers:{sharedFromBase:[],replaceFromBase:[],useFromPose:[],addFromPose:[]},transition:{enterMs:300,exitMs:280,swapStart:.35,swapEnd:.65}}
it('authors distinct expressive actions with continuous loops and settled one-shot endings',()=>{
 const signatures=new Set()
 for(const gesture of ['breathe','focus','nod','recoil','celebrate','wave','look','pet']){
  const motion=createGestureMotion({gesture});const parsed=parsePoseManifest({...manifest,motion})
  expect(parsed.warnings).toEqual([]);const m=parsed.value.motion!
  signatures.add(JSON.stringify(m.parameters))
  const start=samplePoseMotion(m,0),end=samplePoseMotion(m,m.loopDurationMs)
  expect(end).toEqual(start)
  if(m.playback==='once')expect(samplePoseMotion(m,m.loopDurationMs+2000)).toEqual(end)
  const samples=Array.from({length:61},(_,i)=>samplePoseMotion(m,i*m.loopDurationMs/60))
  expect(Math.max(...samples.map(s=>Math.abs(s.parameters.body??0)))).toBeGreaterThan(.08)
 }
 expect(signatures.size).toBe(8)
})
it('delays a measured free joint and rejects independent movement on a locked contact',()=>{
 const joint={layer:'sleeve',origin:{x:.3,y:.2},influence:{axisX:0,axisY:1,start:0,end:.8},rotationDeg:6,lag:.08}
 const motion=createGestureMotion({gesture:'wave',joints:[joint]})
 const rotation=motion.layers.sleeve.rotationDeg!
 expect(rotation.type).toBe('keyframes')
 if(rotation.type==='keyframes')expect(rotation.frames[2].atMs).toBeGreaterThan(motion.parameters.body.frames[2].atMs)
 expect(()=>createGestureMotion({gesture:'wave',joints:[{...joint,contactLocked:true}]})).toThrow('contact-locked')
 expect(()=>createGestureMotion({gesture:'wave',strength:10})).toThrow('strength')
})
it('detects folded intermediate eyelid triangles without rejecting uniformly compressed lids',()=>{
 const mesh={fade:'eyeOpen',nx:1,ny:1,base:[0,0,1,0,0,1,1,1],current:[0,0,1,0,0,.2,1,.2]}
 expect(auditEyeMeshes([mesh])).toMatchObject({folds:0,triangles:2})
 expect(auditEyeMeshes([{...mesh,current:[0,0,1,0,0,1,-1,-1]}]).folds).toBeGreaterThan(0)
 expect(auditEyeMeshes([]).triangles).toBe(0)
})
it('writes a new motion round, preserves source selection and checks actual runtime layers',async()=>{
 const root=await mkdtemp(join(tmpdir(),'creator-motion-'))
 try{
  const dir=join(root,'poses/happy/original');await mkdir(dir,{recursive:true})
  const index={strategy:'whole-model-per-pose',models:[{id:'happy',model:'poses/happy/original/model.json'}]}
  await writeFile(join(root,'models.json'),JSON.stringify(index));await writeFile(join(root,'source.png'),'preserved source')
  await writeFile(join(dir,'model.psd'),tinyPsd());await writeFile(join(dir,'rig.json'),JSON.stringify({cleanupThresholds:{topwear:1}}))
  const sourceConfig={psd:'model.psd',bodySource:'../../../source.png',pose:'pose.json',overrides:'rig.json'}
  await writeFile(join(dir,'model.json'),JSON.stringify(sourceConfig));await writeFile(join(dir,'pose.json'),JSON.stringify({...manifest,id:'happy',source:'../../../source.png'}))
  const plan={intent:'A measured torso lift',gesture:'celebrate',landmarks:[{name:'torso',layer:'topwear',tip:[32,55],root:[32,85]}],joints:[{layer:'topwear',origin:{x:.5,y:.9},influence:{axisX:0,axisY:-1,start:0,end:.8},rotationDeg:2,layerReview:{status:'ready',movingParts:['torso'],remainingFixedParts:[],evidence:['source.png']}}],connections:[{name:'neck',layer:'topwear',parentLayer:'face',points:[24,32,40].map(x=>({child:[x,53],parent:[x,53]})),maxDriftPx:1,reviewBounds:[20,50,25,10]}]}
  await writeFile(join(root,'plan.json'),JSON.stringify(plan))
  const result=await authorMotion({source:root,pose:'happy',round:'lively',plan:join(root,'plan.json')})
  expect(result.selected).toBe(false)
  expect(JSON.parse(await readFile(join(root,'models.json'),'utf8'))).toEqual(index)
  expect(await readFile(join(root,'source.png'),'utf8')).toBe('preserved source')
  expect(JSON.parse(await readFile(join(root,result.model),'utf8')).bodySource).toBe('../../../source.png')
  const authored=JSON.parse(await readFile(join(root,'poses/happy/lively/motion-authorship.json'),'utf8'))
  expect(authored.jointFrames[0].name).toBe('topwear')
  await expect(authorMotion({source:root,pose:'happy',round:'lively',plan:join(root,'plan.json')})).rejects.toThrow()
  plan.joints[0].layer='nonexistent-sleeve';plan.connections[0].layer='nonexistent-sleeve';await writeFile(join(root,'plan.json'),JSON.stringify(plan))
  await expect(authorMotion({source:root,pose:'happy',round:'invalid',plan:join(root,'plan.json')})).rejects.toThrow('Unknown runtime layer')
 }finally{await rm(root,{recursive:true,force:true})}
})
