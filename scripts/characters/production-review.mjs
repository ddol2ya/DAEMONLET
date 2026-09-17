// Private production evidence. A technical test never grants visual acceptance.
import {createHash} from 'node:crypto'
import {readFile,writeFile,realpath,open,rename,rm} from 'node:fs/promises'
import {resolve,dirname,join,relative,sep} from 'node:path'
import {pathToFileURL} from 'node:url'
import {parseArgs} from 'node:util'
import {validateConnections,validateLayerReviews} from './attachment-audit.mjs'

export const POSE_STAGES = ['source','layers','visual','motion']
export const DELIVERY_STAGES = ['renderer','behavior','app','rights']
const digest = data => createHash('sha256').update(data).digest('hex')
const json = async p => JSON.parse(await readFile(p,'utf8'))
const hash = async p => digest(await readFile(p))
const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
async function inside(root, ref) {
  if (typeof ref !== 'string' || !ref) throw Error('Missing source reference')
  const actual = await realpath(resolve(root,ref)), rel = relative(root,actual)
  if (!rel || rel === '..' || rel.startsWith('..'+sep) || resolve(root,rel) !== actual) throw Error('Review reference escapes run')
  return actual
}
export async function snapshotRun(directory) {
  const root = await realpath(directory), index = await json(join(root,'models.json'))
  if (index.strategy !== 'whole-model-per-pose' || !index.models?.length) throw Error('Select independent models before review')
  /** @type {Record<string, {model:string, files:Record<string,string>, fingerprint:string}>} */
  const poses = {}
  for (const model of index.models) {
    if (!idPattern.test(model.id) || poses[model.id]) throw Error('Invalid or duplicate selected pose')
    const file = await inside(root,model.model), config = await json(file), files = {}
    for (const ref of [file,...['psd','bodySource','overrides','pose'].map(k=>resolve(dirname(file),config[k] ?? ''))]) {
      const actual = await inside(root,ref); files[relative(root,actual)] = await hash(actual)
    }
    // A pose manifest can reference its own PSD/overrides; bind those too.
    const poseFile = await inside(root,resolve(dirname(file),config.pose)), pose = await json(poseFile)
    for (const key of ['source','psd','overrides']) if (pose[key]) {
      const actual = await inside(root,resolve(dirname(poseFile),pose[key])); files[relative(root,actual)] = await hash(actual)
    }
    // Coverage, tolerances and isolated-layer evidence are part of this review.
    let authorship
    try {authorship=await inside(root,join(dirname(file),'motion-authorship.json'))} catch(e) {if(e.code!=='ENOENT')throw e}
    if(authorship){
      files[relative(root,authorship)]=await hash(authorship)
      const plan=await json(authorship)
      for(const joint of plan.joints??[])for(const ref of joint.layerReview?.evidence??[]){const actual=await inside(root,ref);files[relative(root,actual)]=await hash(actual)}
    }
    poses[model.id] = {model:model.model,files,fingerprint:digest(JSON.stringify(files))}
  }
  const metadata = {}
  for (const name of ['models.json','plan/poses.json','behavior.json','dialogue.ko.json','persona.json']) {
    try {metadata[name] = await hash(await inside(root,name))} catch(e) {if(e.code !== 'ENOENT') throw e}
  }
  return {poses,metadata,fingerprint:digest(JSON.stringify({poses,metadata}))}
}
async function readLedger(root) {
  try {
    const ledger = await json(join(root,'production-review.json'))
    if (ledger.schemaVersion !== 1 || !Array.isArray(ledger.events)) throw Error('Invalid production-review.json')
    return ledger
  } catch(e) {if(e.code === 'ENOENT') return {schemaVersion:1,events:[]}; throw e}
}
async function context(root, ledger) {
  const snapshot = await snapshotRun(root)
  let packageHash = null
  if (ledger.package) {try {packageHash = await hash(resolve(root,ledger.package))} catch {packageHash = 'missing'}}
  return {snapshot,packagePresent:typeof packageHash==='string'&&packageHash!=='missing', deliveryFingerprint:digest(JSON.stringify([snapshot.fingerprint,packageHash]))}
}
async function eventStatus(root, event, fingerprint) {
  if (!event) return 'pending'
  if (event.fingerprint !== fingerprint) return 'stale'
  for (const evidence of event.evidence) {
    try {if (await hash(await inside(root,evidence.path)) !== evidence.sha256) return 'stale'} catch {return 'stale'}
  }
  return event.verdict
}
export async function reviewStatus(directory) {
  const root = await realpath(directory), ledger = await readLedger(root), {snapshot,deliveryFingerprint,packagePresent} = await context(root,ledger)
  const latest = (pose,stage) => ledger.events.findLast(e=>e.pose===pose&&e.stage===stage)
  /** @type {Record<string, {fingerprint:string, checks:Record<string,string>}>} */
  const poses = {}
  for (const [id,pose] of Object.entries(snapshot.poses)) poses[id] = {
    fingerprint:pose.fingerprint,
    checks:Object.fromEntries(await Promise.all(POSE_STAGES.map(async stage=>[stage,await eventStatus(root,latest(id,stage),pose.fingerprint)]))),
  }
  const delivery = Object.fromEntries(await Promise.all(DELIVERY_STAGES.map(async stage=>[stage,await eventStatus(root,latest(null,stage),deliveryFingerprint)])))
  const readyForPayload = Object.values(poses).every(p=>Object.values(p.checks).every(v=>v==='pass'))
  return {schemaVersion:1,poses,delivery,deliveryFingerprint,package:ledger.package??null,readyForPayload,
    complete:packagePresent&&readyForPayload&&Object.values(delivery).every(v=>v==='pass'),
    meaning:'Pass is a recorded review of these exact assets and evidence; rights pass records the review, not a grant of rights.'}
}
export async function requirePoseReviews(directory, ids) {
  const status = await reviewStatus(directory)
  for (const id of ids) for (const stage of POSE_STAGES) {
    if (status.poses[id]?.checks[stage] !== 'pass') throw Error(`Production review required: ${id}/${stage} (${status.poses[id]?.checks[stage]??'missing'})`)
  }
  return status
}
export async function updateReview(directory, request) {
  const root = await realpath(directory), lock = join(root,'production-review.lock'), file = join(root,'production-review.json')
  const handle = await open(lock,'wx')
  const temporary = file+'.tmp-'+process.pid
  try {
    const ledger = await readLedger(root)
    if (request.package) {
      const pack = await realpath(request.package)
      if (!pack.endsWith('.petchar')) throw Error('Bind an exported .petchar file')
      await hash(pack); ledger.package = relative(root,pack)
    } else {
      const {snapshot,deliveryFingerprint} = await context(root,ledger), pose = request.pose ?? null
      const stages = pose === null ? DELIVERY_STAGES : POSE_STAGES
      if (!stages.includes(request.stage) || pose !== null&&!snapshot.poses[pose]) throw Error('Unknown pose or review stage')
      if (!['pass','fail'].includes(request.verdict) || !request.notes?.trim() || !request.evidence?.length) throw Error('Review requires pass|fail, notes and inspected evidence')
      const fingerprint = pose === null ? deliveryFingerprint : snapshot.poses[pose].fingerprint
      if (request.expected !== fingerprint) throw Error('Review fingerprint changed; inspect the current candidate first')
      const evidence = []
      for (const ref of request.evidence) {const path = await inside(root,ref); evidence.push({path:relative(root,path),sha256:await hash(path)})}
      if(pose!==null&&request.stage==='motion'&&request.verdict==='pass'){
        const configFile=await inside(root,snapshot.poses[pose].model),config=await json(configFile),manifest=await json(await inside(root,resolve(dirname(configFile),config.pose)))
        const movingLayers=Object.keys(manifest.motion?.layers??{})
        if(movingLayers.length){
          let authored
          try{authored=await json(await inside(root,join(dirname(configFile),'motion-authorship.json')))}catch(e){if(e.code==='ENOENT')throw Error('Motion pass requires layer review and attachment authorship');throw e}
          validateLayerReviews(movingLayers.map(layer=>({...authored.joints?.find(j=>j.layer===layer),layer})))
          validateConnections(authored.connections??[],movingLayers)
          let captured=false
          for(const e of evidence)if(e.path.endsWith('.json')){
            let c;try{c=await json(await inside(root,e.path))}catch{continue}
            if(c.pose===pose&&c.sourceFingerprint===fingerprint&&c.motionAuditPassed===true&&c.motionFrames>0&&c.attachments?.pass===true&&c.attachments.coverageValid===true&&movingLayers.every(layer=>c.attachments.connections.some(a=>a.layer===layer&&a.pass===true)))captured=true
          }
          if(!captured)throw Error('Motion pass requires an inspected, successful --motion --contacts capture.json for these exact assets')
        }
      }
      ledger.events.push({at:new Date().toISOString(),pose,stage:request.stage,verdict:request.verdict,notes:request.notes.trim(),fingerprint,evidence})
    }
    await writeFile(temporary,JSON.stringify(ledger,null,2)+'\n',{flag:'wx'})
    await rename(temporary,file)
  } finally {await handle.close();await rm(lock,{force:true});await rm(temporary,{force:true})}
  return reviewStatus(root)
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const {values} = parseArgs({options:{...Object.fromEntries(['source','pose','stage','verdict','notes','expected','package'].map(k=>[k,{type:'string'}])),evidence:{type:'string',multiple:true}}})
  if (!values.source) throw Error('Require --source <run>; omit stage/package for read-only status')
  const result = values.stage||values.package ? await updateReview(values.source,values) : await reviewStatus(values.source)
  console.log(JSON.stringify(result,null,2))
}
