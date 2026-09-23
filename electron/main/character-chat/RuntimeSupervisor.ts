import {promisify} from 'node:util'
import {CHAT_REPLY_SCHEMA,parseChatReply} from '../../shared/character-chat-semantics'
import {dialoguePrefix,ChatSSEDecoder} from '../../shared/character-chat-stream'
import {verifyRuntime,runtimeTarget} from './runtime-artifacts.mjs'
import {streamChunks} from './stream'
import {spawn,type ChildProcess,execFile} from 'node:child_process'
import {createServer} from 'node:net'
import {randomBytes} from 'node:crypto'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,dirname,isAbsolute,win32} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {CHAT_RUNTIME_COMMIT} from './catalog'
export type ModelMessage={role:'system'|'user'|'assistant';content:string}
type Launch={model:string;abort:AbortController;child?:ChildProcess;temporary?:string;token:string;url:string;ready:boolean;preparation:Promise<void>;closing?:Promise<void>;cleanup?:Promise<void>;failure?:Error;log:string}
const run=promisify(execFile)

// Keep DLL discovery within the verified runtime and Windows system directories.
export function runtimeEnvironment(directory:string,platform=process.platform,source=process.env) {
 const env:NodeJS.ProcessEnv={}
 for(const [key,value] of Object.entries(source)) if(!/^(?:LLAMA_|HF_|GGML_|CUDA_|CUDACXX|LD_|DYLD_)/i.test(key) && !(platform==='win32' && key.toLowerCase()==='path'))env[key]=value
 if(platform==='win32') {
  const systemRoot=source.SystemRoot || source.SYSTEMROOT
  if(!systemRoot || !win32.isAbsolute(systemRoot))throw Error('Windows 시스템 경로를 확인하지 못했습니다.')
  env.PATH=[directory,win32.join(systemRoot,'System32'),systemRoot].join(';')
 }
 return env
}
export async function stopOwnedProcess(child:ChildProcess,platform=process.platform) {
 if(child.exitCode!==null || child.signalCode!==null || !child.pid)return
 await new Promise<void>((resolve,reject)=>{
  let force:ReturnType<typeof setTimeout>,deadline:ReturnType<typeof setTimeout>
  const finish=(error?:Error)=>{clearTimeout(force);clearTimeout(deadline);child.off('exit',exited);child.off('close',exited);child.off('error',failed);error?reject(error):resolve()}
  const exited=()=>finish(),failed=(error:Error)=>{if(child.exitCode!==null || child.signalCode!==null)finish();else finish(error)}
  child.once('exit',exited);child.once('close',exited);child.once('error',failed)
  force=setTimeout(()=>{try{child.kill('SIGKILL')}catch(e){finish(e as Error)}},4000)
  deadline=setTimeout(()=>finish(Error('추론 프로세스 종료를 확인하지 못했습니다.')),8000)
  try{if(platform==='win32'&&child.stdin)child.stdin.end();else child.kill('SIGTERM')}catch(e){finish(e as Error)}
 })
}
export class RuntimeSupervisor {
 private current:Launch|null=null
 private owned=new Set<Launch>()
 private generation:AbortController|null=null
 private availabilityProbe:AbortController|null=null
 availabilityError:string|null=null
 constructor(readonly binary:string){}
 private options(signal:AbortSignal,timeout=60000) {return {encoding:'utf8' as const,timeout,signal,windowsHide:true,shell:false as const,cwd:dirname(this.binary),env:runtimeEnvironment(dirname(this.binary)),maxBuffer:2*1024*1024}}
 private async probe(signal:AbortSignal,deadline=performance.now()+60000) {
  const entry=await verifyRuntime(dirname(this.binary),runtimeTarget(),{signal})
  signal.throwIfAborted()
  if(entry.commit!==CHAT_RUNTIME_COMMIT || !isAbsolute(this.binary) || join(dirname(this.binary),entry.executable)!==this.binary)throw Error('지원하지 않는 추론 런타임입니다.')
  const remaining=()=>{signal.throwIfAborted();const time=Math.floor(deadline-performance.now());if(time<=0)throw Error('모델 준비 시간이 초과되었습니다.');return time}
  const executable=entry.launcher?join(dirname(this.binary),entry.launcher):this.binary
  const h=await run(executable,['--help'],this.options(signal,remaining()))
  const d=await run(executable,['--list-devices'],this.options(signal,remaining()))
  signal.throwIfAborted()
  const devices=d.stdout+d.stderr
  if(entry.backend==='Metal' ? !/MTL0|Metal/.test(devices) : !/CUDA\d+.*(?:NVIDIA|GeForce|RTX|Tesla|Quadro)/i.test(devices))throw Error(entry.backend==='Metal'?'Apple Silicon / Metal을 사용할 수 없습니다.':'NVIDIA CUDA 장치를 사용할 수 없습니다. 그래픽 드라이버를 확인해 주세요.')
  return {entry,help:h.stdout+h.stderr}
 }
 async available(){const controller=new AbortController();this.availabilityProbe?.abort();this.availabilityProbe=controller;try{await this.probe(AbortSignal.any([controller.signal,AbortSignal.timeout(60000)]));this.availabilityError=null;return true}catch(e){if(controller.signal.aborted)throw controller.signal.reason;const message=e instanceof Error?e.message:'';this.availabilityError=/^(?:NVIDIA|Apple|지원하지|모델 준비)/.test(message)?message:'로컬 대화 실행 파일을 확인하지 못했습니다. 앱 패키지를 다시 준비해 주세요.';return false}finally{if(this.availabilityProbe===controller)this.availabilityProbe=null}}
 start(model:string):Promise<void> {
  if(this.current?.model===model && !this.current.abort.signal.aborted && !this.current.failure && this.current.child?.exitCode===null && !this.current.child.signalCode)return this.current.preparation
  const previous=[...this.owned]
  for(const item of previous)item.abort.abort()
  const launch:Launch={model,abort:new AbortController(),token:'',url:'',ready:false,log:'',preparation:Promise.resolve()}
  this.current=launch;this.owned.add(launch)
  launch.preparation=Promise.resolve().then(async()=>{
   await Promise.all(previous.map(item=>this.closeSession(item)))
   launch.abort.signal.throwIfAborted()
   await this.prepare(launch)
  }).catch(async error=>{launch.abort.abort();await this.cleanup(launch);this.owned.delete(launch);if(this.current===launch)this.current=null;throw error})
  return launch.preparation
 }
 private async prepare(session:Launch) {
  const signal=session.abort.signal,deadline=performance.now()+180000
  const {help,entry}=await this.probe(signal,deadline)
  signal.throwIfAborted()
  const port=await new Promise<number>((resolve,reject)=>{const s=createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=(s.address() as {port:number}).port;s.close(()=>resolve(p))})})
  signal.throwIfAborted()
  session.temporary=await mkdtemp(join(tmpdir(),'daemonlet-chat-'))
  signal.throwIfAborted()
  if(process.platform==='win32') {
   const systemRoot=process.env.SystemRoot || process.env.SYSTEMROOT!
   const identity=await run(join(systemRoot,'System32','whoami.exe'),['/user','/fo','csv','/nh'],this.options(signal,10000))
   const sid=identity.stdout.match(/S-1-5-[0-9-]+/)?.[0]
   if(!sid)throw Error('현재 사용자 권한을 확인하지 못했습니다.')
   await run(join(systemRoot,'System32','icacls.exe'),[session.temporary,'/inheritance:r','/grant:r',`*${sid}:(OI)(CI)F`],this.options(signal,10000))
  }
  signal.throwIfAborted()
  session.token=randomBytes(32).toString('hex');const key=join(session.temporary,'auth')
  await writeFile(key,session.token,{mode:0o600,flag:'wx'})
  signal.throwIfAborted();session.url=`http://127.0.0.1:${port}`
  const args=['--model',session.model,'--host','127.0.0.1','--port',String(port),'--api-key-file',key,'--ctx-size','8192','--parallel','1','--n-gpu-layers','999','--cache-type-k','f16','--cache-type-v','f16','--flash-attn','on','--batch-size','512','--ubatch-size','512','--jinja','--reasoning','off','--reasoning-budget','0','--reasoning-format','deepseek','--ctx-checkpoints','1','--no-context-shift','--cache-ram','0','--fit','off','--offline','--no-webui','--no-webui-mcp-proxy','--slots','--verbosity','4']
  for(const flag of args.filter(a=>a.startsWith('--')))if(!help.includes(flag))throw Error('런타임이 필수 옵션을 지원하지 않습니다.')
  signal.throwIfAborted()
  const executable=entry.launcher?join(dirname(this.binary),entry.launcher):this.binary
  const child=session.child=spawn(executable,args,{stdio:[entry.launcher?'pipe':'ignore','pipe','pipe'],windowsHide:true,shell:false,cwd:dirname(this.binary),env:runtimeEnvironment(dirname(this.binary))})
  child.on('error',e=>{session.failure=e})
  const append=(b:Buffer)=>{session.log=(session.log+String(b)).slice(-128000)}
  child.stderr?.on('data',append);child.stdout?.on('data',append)
  while(performance.now()<deadline) {
   signal.throwIfAborted()
   if(session.failure || child.exitCode!==null || child.signalCode!==null)throw Error('추론 서버를 시작하지 못했습니다. 메모리와 런타임을 확인해 주세요.')
   let health:any
   try{health=await this.sessionApi(session,'/health',undefined,Math.min(1000,deadline-performance.now()))}catch{signal.throwIfAborted()}
   if(health?.status==='ok') {
    const props=await this.sessionApi(session,'/props',undefined,Math.min(10000,deadline-performance.now()))
    signal.throwIfAborted()
    const off=/offloaded (\d+)\/(\d+) layers/.exec(session.log)
    const backend=entry.backend==='Metal'?/Metal|MTL0/:/CUDA0/
    if(props.total_slots!==1 || props.default_generation_settings?.n_ctx!==8192 || !off || Number(off[1])<=0 || off[1]!==off[2] || !backend.test(session.log) || !session.log.includes('context checkpoints enabled, max = 1'))throw Error('런타임 설정 적용을 확인하지 못했습니다.')
    session.ready=true;return
   }
   await delay(Math.min(150,Math.max(1,deadline-performance.now())),undefined,{signal})
  }
  throw Error('모델 준비 시간이 초과되었습니다.')
 }
 private requireSession(){const session=this.current;if(!session || !session.ready || session.abort.signal.aborted || session.failure || session.child?.exitCode!==null || session.child.signalCode)throw Error('추론 서버가 준비되지 않았습니다.');return session}
 private async sessionApi(session:Launch,endpoint:string,data?:unknown,timeout=10000):Promise<any> {
  session.abort.signal.throwIfAborted()
  if(timeout<=0)throw Error('모델 준비 시간이 초과되었습니다.')
  const r=await fetch(session.url+endpoint,{method:data===undefined?'GET':'POST',headers:{Authorization:'Bearer '+session.token,'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data),signal:AbortSignal.any([session.abort.signal,AbortSignal.timeout(Math.max(1,Math.floor(timeout)))])})
  if(!r.ok)throw Error('추론 서버 응답 오류');return r.json()
 }
 async api(endpoint:string,data?:unknown){return this.sessionApi(this.requireSession(),endpoint,data)}
 private async renderPrompt(session:Launch,messages:ModelMessage[]){const r=await this.sessionApi(session,'/apply-template',{messages,add_generation_prompt:true,chat_template_kwargs:{enable_thinking:false},reasoning_effort:'none'});if(typeof r.prompt!=='string'||!r.prompt)throw Error('대화 템플릿 오류');return r.prompt}
 async count(messages:ModelMessage[]){const session=this.requireSession();const prompt=await this.renderPrompt(session,messages);const t=await this.sessionApi(session,'/tokenize',{content:prompt,add_special:true,parse_special:true});return t.tokens.length as number}
 async generate(messages:ModelMessage[],onText:(text:string)=>void){
 const session=this.requireSession();if(this.generation)throw Error('이미 생성 중입니다.');const controller=this.generation=new AbortController();const timeout=setTimeout(()=>controller.abort(),180000);let raw='',done=false;
 try{
 // The pinned Gemma chat endpoint's schema grammar permits an optional thought
 // channel even with thinking disabled. Apply the official template unchanged,
 // then constrain sampling to the reply JSON from the first generated token.
 const prompt=await this.renderPrompt(session,messages);controller.signal.throwIfAborted();
 const response=await fetch(session.url+'/completion',{method:'POST',headers:{Authorization:'Bearer '+session.token,'Content-Type':'application/json'},body:JSON.stringify({prompt,n_predict:512,temperature:1,top_p:.95,top_k:64,min_p:0,repeat_penalty:1,presence_penalty:0,frequency_penalty:0,reasoning_budget_tokens:0,cache_prompt:true,samplers:['top_k','top_p','temperature'],json_schema:CHAT_REPLY_SCHEMA,stream:true}),signal:AbortSignal.any([controller.signal,session.abort.signal])});
 if(!response.ok||!response.body)throw Error('대사를 생성하지 못했습니다.');const parser=new ChatSSEDecoder(data=>{
  if(data==='[DONE]'){if(!done)throw Error('응답이 비정상 종료되었습니다.');return}
  const event=JSON.parse(data);if(event.error)throw Error('추론 오류');
  if(event.reasoning_content?.trim()||event.choices?.[0]?.delta?.reasoning_content?.trim())throw Error('비추론 설정 위반으로 응답을 중단했습니다.');
  if(done||typeof event.content!=='string'||typeof event.stop!=='boolean')throw Error('응답이 비정상 종료되었습니다.');
  raw+=event.content;if(raw.length>32000)throw Error('응답 크기 초과');
  if(raw.trimStart()&&!raw.trimStart().startsWith('{'))throw Error('JSON 이외의 응답을 중단했습니다.');
  const visible=dialoguePrefix(raw);if(/<\/?(?:think|thought)|<\|/i.test(visible))throw Error('생각 태그가 포함된 응답을 중단했습니다.');
  if(event.truncated)throw Error('입력이 잘려 응답을 중단했습니다.');
  if(event.stop){if(event.stop_type==='limit')throw Error('응답 길이 제한에 도달했습니다. 다시 시도해 주세요.');if(!['eos','word'].includes(event.stop_type))throw Error('응답이 비정상 종료되었습니다.');done=true}
  if(visible)onText(visible)
 });
 for await(const bytes of streamChunks(response.body))parser.push(bytes);parser.end();if(!done)throw Error('응답이 비정상 종료되었습니다.');return parseChatReply(raw)
 }finally{controller.abort();clearTimeout(timeout);if(this.generation===controller)this.generation=null}
 }
 async cancel(){this.generation?.abort();const session=this.current;if(!session)return;if(!session.ready){await this.closeSession(session);return}const deadline=performance.now()+4000;while(performance.now()<deadline){try{const slots=await this.sessionApi(session,'/slots',undefined,Math.min(500,deadline-performance.now()));if(slots.length===1&&!slots[0].is_processing)return}catch{break}await delay(50)}await this.closeSession(session)}
 private cleanup(session:Launch):Promise<void> {
  if(session.cleanup)return session.cleanup
  session.cleanup=(async()=>{if(session.child)await stopOwnedProcess(session.child);if(session.temporary)await rm(session.temporary,{recursive:true,force:true,maxRetries:4,retryDelay:100});session.token='';session.url='';session.ready=false})().catch(error=>{session.cleanup=undefined;throw error})
  return session.cleanup
 }
 private closeSession(session:Launch):Promise<void> {
  session.abort.abort()
  if(session.closing)return session.closing
  session.closing=(async()=>{await session.preparation.catch(()=>{});await this.cleanup(session);this.owned.delete(session);if(this.current===session)this.current=null})().catch(error=>{session.closing=undefined;throw error})
  return session.closing
 }
 async stop(){this.availabilityProbe?.abort();this.generation?.abort();await Promise.all([...this.owned].map(session=>this.closeSession(session)))}
}
