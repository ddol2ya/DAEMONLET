/** Explicit native acceptance probe. Uses existing local models only. */
import {parseArgs} from 'node:util'
import {join,dirname,resolve} from 'node:path'
import {mkdir,writeFile} from 'node:fs/promises'
import {RuntimeSupervisor} from '../electron/main/character-chat/RuntimeSupervisor'
import {ModelManager} from '../electron/main/character-chat/ModelManager'
import {CHAT_MODELS} from '../electron/main/character-chat/catalog'
import {isGpuBackendPreference} from '../electron/shared/gpu-backend'
import type {ModelMessage} from '../electron/main/character-chat/RuntimeSupervisor'

const {values}=parseArgs({options:{runtime:{type:'string'},model:{type:'string'},id:{type:'string'},backend:{type:'string',default:'auto'},output:{type:'string'}}})
if(!values.runtime||!values.model||!values.output||!['E4B','12B'].includes(values.id??'')||!isGpuBackendPreference(values.backend))throw Error('Require --runtime <directory> --model <existing GGUF> --id E4B|12B --backend auto|cuda|vulkan --output <new report>')
const id=values.id as 'E4B'|'12B',path=resolve(values.model)
if(join(dirname(path),CHAT_MODELS[id].filename)!==path)throw Error('Use the pinned model filename')
const manager=new ModelManager(dirname(path),()=>{})
await manager.verify(id)
const runtime=new RuntimeSupervisor(join(resolve(values.runtime),process.platform==='win32'?'llama-server.exe':'llama-server'))
runtime.backendPreference=values.backend
const report:any={model:id,requestedBackend:values.backend,platform:process.platform,checks:{},replies:[]}
const messages:ModelMessage[]=[{role:'system',content:'한국어로 짧게 답하세요. JSON의 text에 대사를 넣고 emotion은 neutral, intent는 chat, gesture는 none, intensity는 0을 사용하세요.'},{role:'user',content:'안녕! 오늘도 함께 이야기하자.'}]
try{
 const started=Date.now()
 if(!await runtime.available())throw Error(runtime.availabilityError??'GPU unavailable')
 report.detected=runtime.selectedDevice
 await runtime.start(path);report.loadMs=Date.now()-started;report.selected=runtime.selectedDevice
 let chunks=0
 const first=await runtime.generate(messages,()=>{chunks++})
 report.replies.push(first.text);report.checks.firstReply=first.text.trim().length>0;report.checks.streamed=chunks>0
 messages.push({role:'assistant',content:first.text},{role:'user',content:'좋아. 지금 무엇을 하고 있다고 했지?'})
 const second=await runtime.generate(messages,()=>{})
 report.replies.push(second.text);report.checks.secondReply=second.text.trim().length>0
 let cancelled:Promise<void>|undefined,interrupted=false
 try{await runtime.generate([{role:'user',content:'1부터 100까지 각각 다른 동물 이름을 붙여서 아주 길게 나열해 줘.'}],()=>{cancelled??=runtime.cancel()})}catch{interrupted=!!cancelled}
 await cancelled
 report.checks.cancelObserved=!!cancelled&&interrupted
 const recovered=await runtime.generate([{role:'user',content:'이제 짧게 안녕이라고 말해 줘.'}],()=>{})
 report.replies.push(recovered.text);report.checks.recovered=recovered.text.trim().length>0
 await runtime.stop();report.checks.stopped=true
 report.passed=Object.values(report.checks).every(Boolean)
}catch(error){report.passed=false;report.error=error instanceof Error?error.message:String(error)}
finally{await runtime.stop();await mkdir(dirname(resolve(values.output)),{recursive:true});await writeFile(resolve(values.output),JSON.stringify(report,null,2)+'\n',{flag:'wx'})}
console.log(JSON.stringify(report))
if(!report.passed)process.exitCode=1
