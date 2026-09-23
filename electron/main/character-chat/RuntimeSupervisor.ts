import {promisify} from 'node:util'
import {CHAT_REPLY_SCHEMA,parseChatReply} from '../../shared/character-chat-semantics'
import {dialoguePrefix,ChatSSEDecoder} from '../../shared/character-chat-stream'
import trustedRuntime from './runtime-catalog.json'
import {streamChunks} from './stream'
import {spawn,type ChildProcess,execFile} from 'node:child_process'
import {createServer} from 'node:net'
import {randomBytes} from 'node:crypto'
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,dirname} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {CHAT_RUNTIME_COMMIT,CHAT_SETTINGS} from './catalog'
import {digestFile} from './ModelManager'
export type ModelMessage={role:'system'|'user'|'assistant';content:string}
export class RuntimeSupervisor {
 private child:ChildProcess|null=null
 private token='';private url='';private temporary:string|null=null
 private generation:AbortController|null=null
 private startEpoch=0
 private activeModel:string|null=null
 private probe:AbortController|null=null
 constructor(readonly binary:string){}
 async available(){try{await readFile(join(dirname(this.binary),'runtime-lock.json'));return true}catch{return false}}
 async start(model:string){if(this.activeModel===model&&this.child?.exitCode===null&&!this.child.signalCode)return;await this.stop();const epoch=++this.startEpoch;
  const lock=JSON.parse(await readFile(join(dirname(this.binary),'runtime-lock.json'),'utf8')) as {commit:string;files:Record<string,string>};if(JSON.stringify(lock)!==JSON.stringify(trustedRuntime)||lock.commit!==CHAT_RUNTIME_COMMIT)throw Error('지원하지 않는 추론 런타임입니다.');for(const [name,digest] of Object.entries(lock.files)){if(!/^[\w.\-]+$/.test(name)||await digestFile(join(dirname(this.binary),name))!==digest)throw Error('추론 런타임 파일 검증 실패')}
  const probe=this.probe=new AbortController();let help:string,devices:string;try{const h=await promisify(execFile)(this.binary,['--help'],{encoding:'utf8',timeout:60000,signal:probe.signal});help=h.stdout+h.stderr;const d=await promisify(execFile)(this.binary,['--list-devices'],{encoding:'utf8',timeout:60000,signal:probe.signal});devices=d.stdout+d.stderr}catch{throw Error('추론 런타임을 준비하지 못했습니다. 다시 시도해 주세요.')}if(epoch!==this.startEpoch)throw Error('모델 준비가 취소되었습니다.');if(process.platform!=='darwin'||process.arch!=='arm64'||!/MTL0|Metal/.test(devices))throw Error('현재 빌드에서 검증된 실행 환경은 Apple Silicon / Metal입니다.');
  const port=await new Promise<number>((resolve,reject)=>{const s=createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=(s.address() as {port:number}).port;s.close(()=>resolve(p))})});
  this.temporary=await mkdtemp(join(tmpdir(),'daemonlet-chat-'));this.token=randomBytes(32).toString('hex');const key=join(this.temporary,'auth');await writeFile(key,this.token,{mode:0o600});this.url=`http://127.0.0.1:${port}`;
  const args=['--model',model,'--host','127.0.0.1','--port',String(port),'--api-key-file',key,'--ctx-size','8192','--parallel','1','--n-gpu-layers','999','--cache-type-k','f16','--cache-type-v','f16','--flash-attn','on','--batch-size','512','--ubatch-size','512','--jinja','--reasoning','off','--reasoning-budget','0','--reasoning-format','deepseek','--ctx-checkpoints','1','--no-context-shift','--cache-ram','0','--fit','off','--offline','--no-webui','--no-webui-mcp-proxy','--slots','--verbosity','4'];for(const flag of args.filter(a=>a.startsWith('--')))if(!help.includes(flag))throw Error('런타임이 필수 옵션을 지원하지 않습니다.');
  let log='',failure:Error|null=null;const child=this.child=spawn(this.binary,args,{stdio:['ignore','pipe','pipe'],env:Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('LLAMA_')&&!k.startsWith('HF_')))});child.once('error',e=>{failure=e});child.stderr?.on('data',b=>{log=(log+String(b)).slice(-128000)});child.stdout?.on('data',b=>{log=(log+String(b)).slice(-128000)});
  try{for(let attempt=0;attempt<1200;attempt++){if(epoch!==this.startEpoch)throw Error('모델 준비가 취소되었습니다.');if(failure||child.exitCode!==null||child.signalCode!==null)throw Error('추론 서버를 시작하지 못했습니다. 메모리와 런타임을 확인해 주세요.');try{const health=await this.api('/health');if(health.status==='ok'){const props=await this.api('/props');const off=/offloaded (\d+)\/(\d+) layers/.exec(log);if(props.total_slots!==1||props.default_generation_settings?.n_ctx!==8192||!off||off[1]!==off[2]||!log.includes('context checkpoints enabled, max = 1'))throw Error('런타임 설정 적용을 확인하지 못했습니다.');this.activeModel=model;return}}catch(e){if(e instanceof Error&&e.message.startsWith('런타임 설정'))throw e}await delay(150)}throw Error('모델 준비 시간이 초과되었습니다.')}catch(e){await this.stop();throw e}
 }
 async api(endpoint:string,data?:unknown):Promise<any>{const r=await fetch(this.url+endpoint,{method:data===undefined?'GET':'POST',headers:{Authorization:'Bearer '+this.token,'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data),signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('추론 서버 응답 오류');return r.json()}
 async count(messages:ModelMessage[]){const r=await this.api('/apply-template',{messages,add_generation_prompt:true,chat_template_kwargs:{enable_thinking:false},reasoning_effort:'none'});if(typeof r.prompt!=='string')throw Error('대화 템플릿 오류');const t=await this.api('/tokenize',{content:r.prompt,add_special:true,parse_special:true});return t.tokens.length as number}
 async generate(messages:ModelMessage[],onText:(text:string)=>void){
 if(this.generation)throw Error('이미 생성 중입니다.');const controller=this.generation=new AbortController();const timeout=setTimeout(()=>controller.abort(),180000);let raw='',done=false,finish='';
 try{const response=await fetch(this.url+'/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+this.token,'Content-Type':'application/json'},body:JSON.stringify({messages,max_tokens:512,temperature:1,top_p:.95,top_k:64,min_p:0,repeat_penalty:1,presence_penalty:0,frequency_penalty:0,reasoning_budget_tokens:0,cache_prompt:true,reasoning_effort:'none',chat_template_kwargs:{enable_thinking:false},samplers:['top_k','top_p','temperature'],response_format:{type:'json_schema',json_schema:{name:'character_reply',strict:true,schema:CHAT_REPLY_SCHEMA}},stream:true}),signal:controller.signal});
 if(!response.ok||!response.body)throw Error('대사를 생성하지 못했습니다.');const parser=new ChatSSEDecoder(data=>{if(data==='[DONE]'){done=true;return}const event=JSON.parse(data);if(event.error)throw Error('추론 오류');const delta=event.choices?.[0]?.delta;finish=event.choices?.[0]?.finish_reason||finish;if(delta?.reasoning_content?.trim())throw Error('비추론 설정 위반으로 응답을 중단했습니다.');if(delta?.content){raw+=delta.content;if(raw.length>32000)throw Error('응답 크기 초과');const visible=dialoguePrefix(raw);if(/<\/?(?:think|thought)|<\|/.test(visible))throw Error('생각 태그가 포함된 응답을 중단했습니다.');if(visible)onText(visible)}});
 for await(const bytes of streamChunks(response.body))parser.push(bytes);parser.end();if(!done||finish!=='stop')throw Error(finish==='length'?'응답 길이 제한에 도달했습니다. 다시 시도해 주세요.':'응답이 비정상 종료되었습니다.');return parseChatReply(raw)
 }finally{clearTimeout(timeout);if(this.generation===controller)this.generation=null}
 }
 async cancel(){this.generation?.abort();if(!this.child)return;for(let i=0;i<80;i++){try{const slots=await this.api('/slots');if(slots.length===1&&!slots[0].is_processing)return}catch{break}await delay(50)}await this.stop()}
 async stop(){++this.startEpoch;this.probe?.abort();this.probe=null;this.generation?.abort();this.activeModel=null;const child=this.child;this.child=null;if(child&&child.exitCode===null&&child.signalCode===null)await new Promise<void>(resolve=>{const timer=setTimeout(()=>child.kill('SIGKILL'),4000);child.once('exit',()=>{clearTimeout(timer);resolve()});child.kill('SIGTERM')});if(this.temporary){await rm(this.temporary,{recursive:true,force:true});this.temporary=null}this.token='';this.url=''}
}
