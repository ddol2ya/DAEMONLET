import {it,expect} from 'vitest'
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {packFiles,writePayload} from './helpers/character-pack'
import {exportPack} from '../scripts/characters/export-pack.mjs'
import {extractCharacterPack} from '../electron/main/CharacterPackArchive'
import {validateChatDefinition,resolveChatPose,neutralMeaning} from '../electron/shared/character-chat-semantics'
import {CharacterRegistry} from '../electron/main/CharacterRegistry'
import {builtinFixture} from './helpers/character-pack'
import {validatePackDirectory} from '../electron/main/CharacterPackAssets'
it('authoring → actual export → archive validator → registry install connects unrelated pose IDs',async()=>{
 const root=await mkdtemp(join(tmpdir(),'chat-export-'));try{const registry=new CharacterRegistry(join(root,'user'),await builtinFixture(join(root,'builtin')),async input=>input.kind==='directory'?validatePackDirectory(input.path):extractCharacterPack(input.path,input.transactionRoot!));await registry.initialize();
 for(const [id,poseId] of [['synthetic-a','pose_07'],['synthetic-b','chin_rest']]){const payload=join(root,id),entries=packFiles({id}).filter(e=>e.path!=='pack.json');const rig=entries.find(e=>e.path==='rig.json')!;rig.data=Buffer.from(JSON.stringify({...JSON.parse(rig.data.toString()),anchorOverrides:{eyeL:{x0:21,y0:28,x1:29,y1:35,icx:25,icy:31,closeY:32},eyeR:{x0:35,y0:28,x1:43,y1:35,icx:39,icy:31,closeY:32}}}));const character=JSON.parse(entries[0].data.toString());character.poses=['pose.json'];entries[0].data=Buffer.from(JSON.stringify(character));entries.push({path:'pose.json',data:Buffer.from(JSON.stringify({schemaVersion:1,id:poseId,label:'Synthetic pose',source:'source.png',psd:'model.psd',overrides:'rig.json',strategy:'independent-model',registration:{strategy:'identity',maxScaleDelta:0,maxRotationDeg:0,maxAnchorErrorPx:0},layers:{sharedFromBase:[],replaceFromBase:[],useFromPose:[],addFromPose:[]},transition:{enterMs:100,exitMs:100,swapStart:0,swapEnd:1}}))});await writePayload(payload,entries);const plan=join(root,id+'-plan.json');await writeFile(plan,JSON.stringify({profile:{displayName:"별이"},models:[{id:poseId,meaningReview:'confirmed',intendedMeaning:{when:{phase:'replying',emotion:'concerned'}}}]}));const output=join(root,id+'.petchar');await exportPack({'character-root':payload,version:'1.0.0',output,'chat-plan':plan});const preview=await registry.prepareImport(output,'authoring-test');const selected=await registry.commitImport(preview.token,'authoring-test');const manifest=JSON.parse(new TextDecoder().decode(await registry.readPersonaAsset(selected,'character.json')));expect(manifest.chat).toBe('chat.json');const chat=JSON.parse(new TextDecoder().decode(await registry.readPersonaAsset(selected,manifest.chat)));expect(chat.profile.displayName).toBe("별이");expect(selected.name).not.toBe("별이");expect(resolveChatPose(validateChatDefinition(chat,[poseId],true).value,'replying',{...neutralMeaning(),emotion:'concerned'}).poseId).toBe(poseId)}await registry.dispose()
 }finally{await rm(root,{recursive:true,force:true})}
},30000)
