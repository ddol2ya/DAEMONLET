import {parseArgs} from 'node:util'
import {access,copyFile,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises'
import {constants} from 'node:fs'
import {join,dirname,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {pathToFileURL} from 'node:url'
import {withPackTools} from './pack-tools.mjs'
import {exportPack} from './export-pack.mjs'
export async function upgradePackChat(values){
 for(const key of ['input','chat-plan','version','output','report'])if(!values[key])throw Error('Missing --'+key)
 for(const key of ['output','report'])if(await access(values[key]).then(()=>true,()=>false))throw Error('Output exists; preserve original and choose a new version/path')
 const stage=await mkdtemp(join(tmpdir(),'petchar-chat-'));try{return await withPackTools(async tools=>{
 const original=await tools.extractCharacterPack(resolve(values.input),stage);if(tools.comparePackVersions(values.version,original.manifest.version)<=0)throw Error('PACK_DOWNGRADE');const payload=join(stage,'payload');await rm(join(payload,'pack.json'));
 const character=JSON.parse(await readFile(join(payload,'character.json'),'utf8'));let personaPath;
 if(values.persona){personaPath=character.persona?tools.resolvePackReference(character.persona,'character.json'):'persona.json';const persona=tools.parseCharacterPersona(await readFile(values.persona));await writeFile(join(payload,personaPath),JSON.stringify(persona,null,2)+'\n');character.persona=personaPath;await writeFile(join(payload,'character.json'),JSON.stringify(character,null,2)+'\n')}
 const output=join(stage,'candidate.petchar'),chatReport=join(stage,'chat-review.json');const result=await exportPack({'character-root':payload,'chat-plan':values['chat-plan'],'chat-report':chatReport,version:values.version,output},original.manifest);
 const verification=join(stage,'verify');await mkdir(verification);const checked=await tools.extractCharacterPack(output,verification);const allowed=new Set(['character.json',character.chat||'chat.json',...(personaPath?[personaPath]:[])]),unchanged=[];
 for(const f of original.manifest.files)if(!allowed.has(f.path)){const next=checked.manifest.files.find(x=>x.path===f.path);if(!next||next.sha256!==f.sha256||next.bytes!==f.bytes)throw Error('Payload changed outside chat/persona: '+f.path);unchanged.push(f.path)}
 const report={input:{id:original.manifest.id,version:original.manifest.version,sha256:tools.sha256(await readFile(values.input))},output:{...result,output:resolve(values.output),sha256:tools.sha256(await readFile(output))},poseCount:checked.poseCount,allowedChanges:['pack.json',...allowed],unchangedFiles:unchanged,semanticReview:JSON.parse(await readFile(chatReport,'utf8')),visualAssetChanges:0,visualQA:'not_run'};
 await mkdir(dirname(resolve(values.output)),{recursive:true});await mkdir(dirname(resolve(values.report)),{recursive:true});await copyFile(output,values.output,constants.COPYFILE_EXCL);await writeFile(values.report,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});return report
 })}finally{await rm(stage,{recursive:true,force:true})}}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){const {values}=parseArgs({options:Object.fromEntries(['input','chat-plan','persona','version','output','report'].map(k=>[k,{type:'string'}]))});const r=await upgradePackChat(values);console.log(JSON.stringify({id:r.output.id,version:r.output.version,poseCount:r.poseCount,visualAssetChanges:0},null,2))}
