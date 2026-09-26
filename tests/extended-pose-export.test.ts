import {it,expect} from 'vitest'
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {packFiles,writePayload} from './helpers/character-pack'
import {exportPack} from '../scripts/characters/export-pack.mjs'
import {extractCharacterPack} from '../electron/main/CharacterPackArchive'

it.each([32,34,64])('exports %i independent assets with minimal required capabilities',async count=>{
 const root=await mkdtemp(join(tmpdir(),'extended-pose-export-'))
 try {
  const entries=packFiles({id:'extended-fixture'}).filter(e=>e.path!=='pack.json')
  const rig=entries.find(e=>e.path==='rig.json')!
  rig.data=Buffer.from(JSON.stringify({...JSON.parse(rig.data.toString()),anchorOverrides:{eyeL:{x0:21,y0:28,x1:29,y1:35,icx:25,icy:31,closeY:32},eyeR:{x0:35,y0:28,x1:43,y1:35,icx:39,icy:31,closeY:32}}}))
  const character=JSON.parse(entries[0].data.toString());character.poses=[]
  for(let i=0;i<count;i++){
   const prefix=`poses/pose-${i}/`;character.poses.push(prefix+'pose.json')
   for(const name of ['source.png','model.psd','rig.json'])entries.push({path:prefix+name,data:entries.find(e=>e.path===name)!.data})
   entries.push({path:prefix+'pose.json',data:Buffer.from(JSON.stringify({schemaVersion:1,id:`pose-${i}`,label:`Pose ${i}`,source:'source.png',psd:'model.psd',overrides:'rig.json',strategy:'independent-model',registration:{strategy:'identity',maxScaleDelta:0,maxRotationDeg:0,maxAnchorErrorPx:0},layers:{sharedFromBase:[],replaceFromBase:[],useFromPose:[],addFromPose:[]},transition:{enterMs:100,exitMs:100,swapStart:0,swapEnd:1}}))})
  }
  entries[0].data=Buffer.from(JSON.stringify(character));const payload=await writePayload(join(root,'input'),entries)
  for(const preserve of [false,true]){
   const output=join(root,`${preserve}.petchar`)
   await exportPack({'character-root':payload,version:'1.1.0',output},preserve?{runtime:{engine:'anime25d',assetApiVersion:1,capabilities:['independent-model']}}:{})
   const verify=join(root,`verify-${preserve}`);await mkdir(verify);const pack=await extractCharacterPack(output,verify)
   expect(pack.poseCount).toBe(count)
   expect(pack.manifest.runtime.capabilities).toContain('pose-variants')
   expect(pack.manifest.runtime.capabilities.includes('extended-pose-library-v1')).toBe(count>32)
   if(count===64)expect(pack.manifest.files.length).toBeGreaterThan(256)
  }
 }finally{await rm(root,{recursive:true,force:true})}
},30000)
