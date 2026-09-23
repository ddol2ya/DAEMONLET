import {mkdir,readFile,rename,writeFile,copyFile,stat,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import type {ChatConversation,ChatMessage,LocalModelId} from '../../shared/character-chat-contract'
export type ExplicitMemory={id:string;text:string}
export type StoredChats={version:2;model:LocalModelId;characterId:string;current?:string;conversations:ChatConversation[];memories:Record<string,ExplicitMemory[]>}
export const CHAT_STORAGE_LIMITS={conversations:500,messages:4000,bytes:32*1024*1024} as const
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9-]{36}$/.test(v)
const safeText=(v:unknown,max:number):v is string=>typeof v==='string'&&v.length<=max&&!/[\u0000-\u0008\u000b-\u001f]/.test(v)
export function validateStoredChats(v:unknown):StoredChats{const x=v as StoredChats;if(!x||![1,2].includes(x.version)||!['E4B','12B'].includes(x.model)||!Array.isArray(x.conversations)||x.conversations.length>CHAT_STORAGE_LIMITS.conversations||!safeText(x.characterId,64))throw Error('CHAT_STORAGE_INVALID');const ids=new Set<string>();for(const c of x.conversations){if(!uuid(c.id)||ids.has(c.id)||!safeText(c.characterId,64)||!safeText(c.title,100)||!Array.isArray(c.messages)||c.messages.length>CHAT_STORAGE_LIMITS.messages)throw Error('CHAT_STORAGE_INVALID');ids.add(c.id);const mids=new Set<string>();for(const m of c.messages){if(!uuid(m.id)||mids.has(m.id)||!['user','assistant'].includes(m.role)||!['complete','streaming','stopped','error'].includes(m.status)||!safeText(m.text,32000)||!Number.isFinite(Date.parse(m.createdAt)))throw Error('CHAT_STORAGE_INVALID');mids.add(m.id);if(m.binding&&(m.binding.characterId!==c.characterId||m.binding.conversationId!==c.id))throw Error('CHAT_STORAGE_OWNER');if(m.semanticDiagnostics&&(!Array.isArray(m.semanticDiagnostics)||m.semanticDiagnostics.length>8||m.semanticDiagnostics.some(d=>!safeText(d,80))))throw Error('CHAT_STORAGE_INVALID')}if(c.summary&&(!safeText(c.summary.text,1600)||c.summary.algorithm!=='extractive-v1'))throw Error('CHAT_STORAGE_INVALID')}
 if(x.current!==undefined&&!x.conversations.some(c=>c.id===x.current&&c.characterId===x.characterId))throw Error('CHAT_STORAGE_OWNER');
 const memories=x.memories??{};if(typeof memories!=='object'||Array.isArray(memories)||Object.keys(memories).length>100)throw Error('CHAT_STORAGE_INVALID');for(const [key,items] of Object.entries(memories)){if(!/^[a-z0-9-]{1,64}$/.test(key)||!Array.isArray(items)||items.length>64||items.some(m=>!uuid(m.id)||!safeText(m.text,500)))throw Error('CHAT_STORAGE_INVALID')}
 return {...x,version:2,memories}}
export function encodeStoredChats(data:StoredChats):string {
 const bytes=JSON.stringify(validateStoredChats(structuredClone(data)))
 if(Buffer.byteLength(bytes)>CHAT_STORAGE_LIMITS.bytes)throw Error('대화 저장 용량 한도에 도달했습니다. 이전 대화를 정리해 주세요.')
 return bytes
}
export class ConversationStore {
 private queue=Promise.resolve();readonly file:string
 constructor(private root:string){this.file=join(root,'conversations.json')}
 async load():Promise<{value:StoredChats|null;recovered:boolean}>{
  await mkdir(this.root,{recursive:true,mode:0o700})
  let bytes:string
  try {
   if((await stat(this.file)).size>CHAT_STORAGE_LIMITS.bytes)throw Error('CHAT_STORAGE_LIMIT')
   bytes=await readFile(this.file,'utf8')
  } catch(e) {
   if((e as NodeJS.ErrnoException).code==='ENOENT')return {value:null,recovered:false}
   // Access/IO errors are not corrupt data and must not turn into an empty store.
   if(!(e instanceof Error)||e.message!=='CHAT_STORAGE_LIMIT')throw e
   await copyFile(this.file,this.file+'.preserved-'+randomUUID())
   return {value:null,recovered:true}
  }
  try {
   const value=validateStoredChats(JSON.parse(bytes))
   for(const c of value.conversations)for(const m of c.messages)if(m.status==='streaming')m.status='stopped'
   return {value,recovered:false}
  } catch {
   await copyFile(this.file,this.file+'.preserved-'+randomUUID())
   return {value:null,recovered:true}
  }
 }
 save(data:StoredChats){
  let bytes:string
  try{bytes=encodeStoredChats(data)}catch(e){return Promise.reject(e)}
  const next=this.queue.catch(()=>{}).then(async()=>{
   const temp=this.file+'.tmp-'+randomUUID()
   try {
    await mkdir(this.root,{recursive:true,mode:0o700})
    await writeFile(temp,bytes,{mode:0o600});await rename(temp,this.file)
   }finally{await rm(temp,{force:true}).catch(()=>{})}
  })
  this.queue=next;return next
 }
}
export function completeContext(messages:ChatMessage[]):Array<{role:'user'|'assistant';content:string}>{const result:Array<{role:'user'|'assistant';content:string}>=[];for(let i=0;i<messages.length-1;i++){const u=messages[i],a=messages[i+1];if(u.role==='user'&&a.role==='assistant'&&u.status==='complete'&&a.status==='complete'){result.push({role:'user',content:u.text},{role:'assistant',content:a.text});i++}}const last=messages.at(-1);if(last?.role==='user')result.push({role:'user',content:last.text});return result}
