import {mkdtemp,mkdir,writeFile,rm,readFile,symlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {resolve} from 'node:path'
import {afterEach,expect,it} from 'vitest'
import {reviewStatus,updateReview,requirePoseReviews,POSE_STAGES,DELIVERY_STAGES} from '../scripts/characters/production-review.mjs'
const roots:string[]=[]
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'production-review-'));roots.push(root)
 await mkdir(join(root,'poses/waiting/r0'),{recursive:true});await mkdir(join(root,'qa'))
 await writeFile(join(root,'models.json'),JSON.stringify({strategy:'whole-model-per-pose',models:[{id:'waiting',model:'poses/waiting/r0/model.json'}]}))
 for(const [name,value] of Object.entries({'model.json':{psd:'model.psd',bodySource:'source.png',overrides:'overrides.json',pose:'pose.json'},'pose.json':{source:'source.png',psd:'model.psd',overrides:'overrides.json'},'overrides.json':{}}))await writeFile(join(root,'poses/waiting/r0',name),JSON.stringify(value))
 await writeFile(join(root,'poses/waiting/r0/model.psd'),'psd');await writeFile(join(root,'poses/waiting/r0/source.png'),'source');await writeFile(join(root,'qa/evidence.json'),'inspected capture')
 return root
}
async function record(root:string,stage:string,verdict='pass',pose:string|null='waiting'){
 const s=await reviewStatus(root)
 return updateReview(root,{pose,stage,verdict,notes:'Inspected current test evidence',expected:pose?s.poses[pose].fingerprint:s.deliveryFingerprint,evidence:['qa/evidence.json']})
}
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})))})
it('requires distinct stage reviews and invalidates them after asset/evidence edits',async()=>{
 const root=await fixture();await expect(requirePoseReviews(root,['waiting'])).rejects.toThrow('source')
 for(const stage of POSE_STAGES)await record(root,stage)
 expect((await requirePoseReviews(root,['waiting'])).readyForPayload).toBe(true)
 const expected=(await reviewStatus(root)).poses.waiting.fingerprint
 await writeFile(join(root,'poses/waiting/r0/model.psd'),'repaired eyes')
 expect((await reviewStatus(root)).poses.waiting.checks.visual).toBe('stale')
 await expect(updateReview(root,{pose:'waiting',stage:'visual',verdict:'pass',notes:'old review',expected,evidence:['qa/evidence.json']})).rejects.toThrow('fingerprint changed')
 await record(root,'visual');await writeFile(join(root,'qa/evidence.json'),'different capture')
 expect((await reviewStatus(root)).poses.waiting.checks.visual).toBe('stale')
})
it('binds completion to the selected archive and keeps a later rejection authoritative',async()=>{
 const root=await fixture();for(const stage of POSE_STAGES)await record(root,stage)
 const pack=join(root,'final.petchar');await writeFile(pack,'archive-a');await updateReview(root,{package:pack})
 for(const stage of DELIVERY_STAGES)await record(root,stage,'pass',null)
 expect((await reviewStatus(root)).complete).toBe(true)
 await record(root,'visual','fail');expect((await reviewStatus(root)).complete).toBe(false)
 await record(root,'visual');await writeFile(pack,'archive-b');expect((await reviewStatus(root)).delivery.app).toBe('stale')
 expect(JSON.parse(await readFile(join(root,'production-review.json'),'utf8')).events.some((e:any)=>e.verdict==='fail')).toBe(true)
})
it('invalidates acceptance when motion coverage, tolerance or isolated-layer evidence changes',async()=>{
 const root=await fixture(),file=join(root,'poses/waiting/r0/motion-authorship.json')
 const authored={connections:[{maxDriftPx:1}],joints:[{layerReview:{evidence:['qa/layer.png']}}]}
 await writeFile(join(root,'qa/layer.png'),'isolated original layer');await writeFile(file,JSON.stringify(authored))
 await record(root,'motion');authored.connections[0].maxDriftPx=12;await writeFile(file,JSON.stringify(authored))
 expect((await reviewStatus(root)).poses.waiting.checks.motion).toBe('stale')
 await record(root,'motion');await writeFile(join(root,'qa/layer.png'),'changed layer review')
 expect((await reviewStatus(root)).poses.waiting.checks.motion).toBe('stale')
})
it('does not record a local-motion pass from generic evidence or a failed attachment capture',async()=>{
 const root=await fixture(),dir=join(root,'poses/waiting/r0')
 const pose=JSON.parse(await readFile(join(dir,'pose.json'),'utf8'));pose.motion={layers:{arm:{}}};await writeFile(join(dir,'pose.json'),JSON.stringify(pose))
 await expect(record(root,'motion')).rejects.toThrow('authorship')
 const authored={joints:[{layer:'arm',layerReview:{status:'ready',movingParts:['forearm'],remainingFixedParts:[],evidence:['qa/evidence.json']}}],connections:[{name:'shoulder',layer:'arm',parentLayer:'torso',points:[0,5,10].map(x=>({child:[x,0],parent:[x,0]})),maxDriftPx:1,reviewBounds:[0,0,10,10]}]}
 await writeFile(join(dir,'motion-authorship.json'),JSON.stringify(authored))
 await expect(record(root,'motion')).rejects.toThrow('successful --motion --contacts')
 const status=await reviewStatus(root),capture={pose:'waiting',sourceFingerprint:status.poses.waiting.fingerprint,motionAuditPassed:false,motionFrames:96,attachments:{pass:false,coverageValid:true,connections:[{layer:'arm',pass:false}]}}
 await writeFile(join(root,'qa/capture.json'),JSON.stringify(capture))
 const request={pose:'waiting',stage:'motion',verdict:'pass',notes:'Inspected attachment crops',expected:status.poses.waiting.fingerprint,evidence:['qa/capture.json']}
 await expect(updateReview(root,request)).rejects.toThrow('successful --motion --contacts')
 capture.motionAuditPassed=true;capture.attachments.pass=true;capture.attachments.connections[0].pass=true;await writeFile(join(root,'qa/capture.json'),JSON.stringify(capture))
 expect((await updateReview(root,request)).poses.waiting.checks.motion).toBe('pass')
})
it('rejects source/evidence paths escaping through a symlink and empty attestations',async()=>{
 const root=await fixture(),other=await fixture();await symlink(join(other,'qa/evidence.json'),join(root,'qa/outside.json'))
 const expected=(await reviewStatus(root)).poses.waiting.fingerprint
 await expect(updateReview(root,{pose:'waiting',stage:'visual',expected,verdict:'pass',notes:'review',evidence:['qa/outside.json']})).rejects.toThrow('escapes')
 await expect(updateReview(root,{pose:'waiting',stage:'visual',expected,verdict:'pass',notes:'',evidence:[]})).rejects.toThrow('notes')
})
it('creator payload refuses an unreviewed pilot before writing output',async()=>{
 const root=await fixture(),models=['waiting','writing','head-tap'].map(id=>({id,label:id,model:'poses/waiting/r0/model.json'}))
 await writeFile(join(root,'models.json'),JSON.stringify({strategy:'whole-model-per-pose',models}))
 const output=join(root,'payload')
 await expect(promisify(execFile)(process.execPath,[resolve('skills/create-pet-character/scripts/creator.mjs'),'payload','--source',root,'--id','pilot','--label','Pilot','--profile','trial','--behavior',join(root,'behavior.json'),'--dialogue',join(root,'dialogue.json'),'--output',output])).rejects.toThrow('Production review required')
})
