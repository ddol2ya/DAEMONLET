/** Shared by the app, pack validator and authoring export. No character IDs. */
export const CHAT_PHASES=['idle','attentive','generating','replying'] as const
export const CHAT_EMOTIONS=['neutral','happy','concerned','shy','surprised','annoyed','playful'] as const
export const CHAT_INTENTS=['chat','explain','question','acknowledge','decline','comfort','celebrate'] as const
export const CHAT_GESTURES=['none','nod','tilt','shake','glance_away','laugh','emphasize'] as const
export type ChatPhase=typeof CHAT_PHASES[number]
export type ChatMeaning={emotion:typeof CHAT_EMOTIONS[number];intent:typeof CHAT_INTENTS[number];gesture:typeof CHAT_GESTURES[number];intensity:number}
export type ChatRule={id:string;when:{phase:ChatPhase;emotion?:ChatMeaning['emotion'];intent?:ChatMeaning['intent']};intensity?:{min:number;max:number};poseId:string;motionPolicy:'chat-safe'|'pose-approved';priority:number;weight:number}
export type ChatProfile={displayName?:string;canonFacts:string[];relationships:string[];defaultScene:string;examples:Array<{user:string;reply:string}>}
export type CharacterChatDefinition={schemaVersion:1;profile:ChatProfile;presentation:{defaultPoseId?:string;rules:ChatRule[]}}
export const CHAT_LIMITS={bytes:65536,rules:256,facts:24,relationships:12,examples:8,profileChars:10000} as const
export const CHAT_COMPILER_VERSION=1
export const neutralMeaning=():ChatMeaning=>({emotion:'neutral',intent:'chat',gesture:'none',intensity:.2})
const failure=(code:string):never=>{throw Error(code)}
const object=(v:unknown,keys:string[]):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))return failure('CHAT_KEYS');return v as Record<string,unknown>}
const text=(v:unknown,max:number,empty=false):string=>{if(typeof v!=='string'||(!empty&&!v.trim())||[...v].length>max||/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ud800-\udfff]/u.test(v))return failure('CHAT_TEXT');return v.normalize('NFC').trim()}
const choice=<T extends string>(v:unknown,values:readonly T[]):T=>values.includes(v as T)?v as T:failure('CHAT_ENUM')
const number=(v:unknown,min:number,max:number):number=>typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max?v:failure('CHAT_NUMBER')
const id=(v:unknown)=>{const s=text(v,80);return /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(s)?s:failure('CHAT_ID')}
export function parseMeaning(v:unknown):ChatMeaning{const o=object(v,['emotion','intent','gesture','intensity']);return {emotion:choice(o.emotion,CHAT_EMOTIONS),intent:choice(o.intent,CHAT_INTENTS),gesture:choice(o.gesture,CHAT_GESTURES),intensity:number(o.intensity,0,1)}}
export function parseChatReply(raw:string):{text:string;meaning:ChatMeaning;diagnostics?:string[]} {
 const v=object(JSON.parse(raw),['text','emotion','intent','gesture','intensity'])
 const dialogue=text(v.text,4000)
 if(/<\/?(?:think|thought)|<\|/i.test(dialogue))throw Error('CHAT_UNSAFE_TEXT')
 try {return {text:dialogue,meaning:parseMeaning({emotion:v.emotion,intent:v.intent,gesture:v.gesture,intensity:v.intensity})}}
 catch(e){return {text:dialogue,meaning:neutralMeaning(),diagnostics:[e instanceof Error?e.message:'CHAT_MEANING']}}
}
export const CHAT_REPLY_SCHEMA={type:'object',additionalProperties:false,required:['text','emotion','intent','gesture','intensity'],properties:{text:{type:'string',minLength:1,maxLength:4000},emotion:{type:'string',enum:CHAT_EMOTIONS},intent:{type:'string',enum:CHAT_INTENTS},gesture:{type:'string',enum:CHAT_GESTURES},intensity:{type:'number',minimum:0,maximum:1}}} as const
export const emptyChat=():CharacterChatDefinition=>({schemaVersion:1,profile:{canonFacts:[],relationships:[],defaultScene:'',examples:[]},presentation:{rules:[]}})
export function validateChatDefinition(value:unknown,poseIds:readonly string[],strict=false):{value:CharacterChatDefinition;diagnostics:string[]}{
 const diagnostics:string[]=[];const fallback=(e:unknown)=>{const message=e instanceof Error?e.message:'CHAT_INVALID';if(strict)throw Error(message);diagnostics.push(message)};let result=emptyChat();
 try{if(new TextEncoder().encode(JSON.stringify(value)).length>CHAT_LIMITS.bytes)throw Error('CHAT_SIZE');const root=object(value,['schemaVersion','profile','presentation']);if(root.schemaVersion!==1)throw Error('CHAT_VERSION');
  if(root.profile!==undefined){const p=object(root.profile,['displayName','canonFacts','relationships','defaultScene','examples']);const list=(v:unknown,max:number)=>{if(!Array.isArray(v)||v.length>max)throw Error('CHAT_LIST');return v.map(x=>text(x,500))};const examples=p.examples??[];if(!Array.isArray(examples)||examples.length>8)throw Error('CHAT_EXAMPLES');result.profile={...(p.displayName===undefined?{}:{displayName:text(p.displayName,80)}),canonFacts:list(p.canonFacts??[],24),relationships:list(p.relationships??[],12),defaultScene:text(p.defaultScene??'',1000,true),examples:examples.map(x=>{const e=object(x,['user','reply']);return {user:text(e.user,400),reply:text(e.reply,400)}})};if(JSON.stringify(result.profile).length>CHAT_LIMITS.profileChars)throw Error('CHAT_PROFILE_SIZE')}
  const p=object(root.presentation??{rules:[]},['defaultPoseId','rules']);if(p.defaultPoseId!==undefined){try{const key=id(p.defaultPoseId);if(!poseIds.includes(key))throw Error('CHAT_POSE_REF');result.presentation.defaultPoseId=key}catch(e){fallback(e)}}
  if(!Array.isArray(p.rules)||p.rules.length>CHAT_LIMITS.rules)throw Error('CHAT_RULES');const seen=new Set<string>();
  for(const candidate of p.rules){try{const r=object(candidate,['id','when','intensity','poseId','motionPolicy','priority','weight']);const ruleId=id(r.id);if(seen.has(ruleId))throw Error('CHAT_DUPLICATE_RULE');seen.add(ruleId);const when=object(r.when,['phase','emotion','intent']);const phase=choice(when.phase,CHAT_PHASES);if(phase!=='replying'&&(when.emotion!==undefined||when.intent!==undefined))throw Error('CHAT_PHASE_OWNER');const poseId=id(r.poseId);if(!poseIds.includes(poseId))throw Error('CHAT_POSE_REF');const priority=number(r.priority??0,0,100);if(!Number.isInteger(priority))throw Error('CHAT_PRIORITY');const weight=number(r.weight??1,Number.MIN_VALUE,100);let intensity:ChatRule['intensity'];if(r.intensity!==undefined){const range=object(r.intensity,['min','max']);intensity={min:number(range.min,0,1),max:number(range.max,0,1)};if(intensity.min>intensity.max)throw Error('CHAT_RANGE')}
   result.presentation.rules.push({id:ruleId,when:{phase,...(when.emotion===undefined?{}:{emotion:choice(when.emotion,CHAT_EMOTIONS)}),...(when.intent===undefined?{}:{intent:choice(when.intent,CHAT_INTENTS)})},...(intensity?{intensity}:{}),poseId,motionPolicy:choice(r.motionPolicy??'chat-safe',['chat-safe','pose-approved']),priority,weight})
  }catch(e){fallback(e)}}
 }catch(e){fallback(e);result=emptyChat()}
 return {value:result,diagnostics}
}
export function resolveChatPose(definition:CharacterChatDefinition,phase:ChatPhase,meaning:ChatMeaning=neutralMeaning(),previous:string|null=null,random= Math.random):{poseId:string|null;motionPolicy:ChatRule['motionPolicy'];ruleId:string|null;reason:string}{
 const candidates=definition.presentation.rules.filter(r=>r.when.phase===phase&&(!r.when.emotion||r.when.emotion===meaning.emotion)&&(!r.when.intent||r.when.intent===meaning.intent)&&(!r.intensity||meaning.intensity>=r.intensity.min&&meaning.intensity<=r.intensity.max));
 const rank=(r:ChatRule)=>phase!=='replying'?1:r.when.emotion&&r.when.intent?4:r.when.emotion?3:r.when.intent?(meaning.emotion==='neutral'?2:0):1;
 const ranked=candidates.filter(r=>rank(r)>0);if(ranked.length){const best=Math.max(...ranked.map(rank)),group=ranked.filter(r=>rank(r)===best),priority=Math.max(...group.map(r=>r.priority));let pool=group.filter(r=>r.priority===priority);if(pool.some(r=>r.poseId!==previous))pool=pool.filter(r=>r.poseId!==previous);let pick=Math.min(.999999,Math.max(0,random()))*pool.reduce((n,r)=>n+r.weight,0);const chosen=pool.find(r=>(pick-=r.weight)<0)||pool[pool.length-1];return {poseId:chosen.poseId,motionPolicy:chosen.motionPolicy,ruleId:chosen.id,reason:'rule'}}
 return {poseId:definition.presentation.defaultPoseId??null,motionPolicy:'chat-safe',ruleId:null,reason:definition.presentation.defaultPoseId?'pack-default':'normal-base-model'}
}
