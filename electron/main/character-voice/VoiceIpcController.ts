import {RuntimeSupervisor} from '../character-chat/RuntimeSupervisor'
import {QwenVoiceInstaller} from './QwenVoiceInstaller'
import {WindowsGgufModelInstaller} from './WindowsGgufModelInstaller'
import {WindowsGgufRuntimeInstaller} from './WindowsGgufRuntimeInstaller'
import {ManagedRuntimeTerms} from './ManagedRuntimeTerms'
import type {GgufRuntimeCatalog} from '../../shared/windows-gguf-runtime-catalog'
import qwenWindowsPolicy from '../../voice/runtime-qwen-gguf-windows.json'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {VOICE_MOUTH_IPC,validVoiceMouth,type VoiceMouthInput} from '../../shared/voice-mouth'
import {DOT_IPC} from '../../shared/dot-presentation'
import {appText,appLanguage} from '../AppLanguage'
import {settingsContext,VOICE_MANAGEMENT_ACTIONS,type VoiceManagementAction} from '../../shared/chat-settings-contract'
import {join,dirname} from 'node:path'
import {preparationMetrics} from './VoicePreparationMetrics'
import {WindowsVoiceInstaller} from './WindowsVoiceInstaller'
import {VoiceBaseInstaller} from './VoiceBaseInstaller'
import {dialog,ipcMain,shell,type BrowserWindow} from 'electron'
import {isTrustedSender} from '../SecurityPolicy'
import {isManagedVoice,isReferenceProfile,VOICE_IPC,type VoiceAction} from '../../shared/character-voice-contract'
import type {CharacterChatService} from '../character-chat/CharacterChatService'
import {CharacterVoiceService} from './CharacterVoiceService'

export class VoiceIpcController {
 readonly service:CharacterVoiceService
 private initialized:Promise<void>|null=null
 private petOutput:BrowserWindow|null=null
 private localAudioEpoch=-1
 private localAudioClaims=new Set<string>()
 private petReady=false
 private presentationOutput=false
 private presentationGeneration=0
 private presentationPlayback:{generation:number;signal:AbortSignal;epoch:number|null;announced:Set<string>;claimed:Set<string>;started:boolean;scheduled:(delayMs:number)=>void}|null=null
 private presentationDetach:Array<()=>void>=[]
 private presentationAttachment:Promise<void>|null=null
 attachPresentationWindow(win:BrowserWindow):Promise<void>{
  if(this.closing)return Promise.reject(Error('VOICE_OUTPUT_EXPIRED'))
  if(this.petOutput===win)return this.presentationAttachment??Promise.resolve()
  const retired=this.detachPresentationWindow()
  this.petOutput=win
  const reset=()=>{if(this.petOutput!==win)return;this.petReady=false;if(this.presentationOutput){this.presentationOutput=false;this.service.setOutputReady(false)}}
  const closed=()=>{if(this.petOutput===win)void this.detachPresentationWindow().catch(e=>this.service.error(e))}
  win.on('hide',reset);win.on('closed',closed);win.webContents.on('did-start-loading',reset);win.webContents.on('render-process-gone',reset)
  this.presentationDetach=[()=>win.removeListener('hide',reset),()=>win.removeListener('closed',closed),()=>win.webContents.removeListener('did-start-loading',reset),()=>win.webContents.removeListener('render-process-gone',reset)]
  const task=retired.then(()=>{if(this.closing||this.petOutput!==win)throw Error('VOICE_OUTPUT_EXPIRED')}).finally(()=>{if(this.presentationAttachment===task)this.presentationAttachment=null})
  this.presentationAttachment=task;return task
 }
 async detachPresentationWindow(){
  for(const off of this.presentationDetach.splice(0))off()
  this.petOutput=null;this.petReady=false
  await this.stopPresentation()
 }

 presentationReady(value:boolean){this.petReady=value;if(!value&&this.presentationOutput){this.presentationOutput=false;this.service.setOutputReady(false)}}
 presentationVoiceIssue(){const s=this.service.snapshot();return this.service.presentationVoiceMuted||!this.petReady||!s.enabled||!s.runtimeConfigured||s.seedError||!s.availableProfiles?.length||!!s.error}
 async setPresentationMuted(value:boolean){
  if(!value&&!this.service.presentationVoiceMuted)return
  const generation=++this.presentationGeneration,pending=this.service.setPresentationMuted(value)
  if(value){this.presentationOutput=false;this.presentationPlayback=null}
  try{await pending}finally{if(value&&generation===this.presentationGeneration)this.updateOutput()}
 }
 async speakPresentation(text:string,signal:AbortSignal,scheduled:(delayMs:number)=>void=()=>{}){
  if(this.playbackReady||!this.petOutput||this.petOutput.isDestroyed()||!this.petOutput.isVisible()||this.presentationVoiceIssue())throw Error('VOICE_PRESENTATION_UNAVAILABLE')
  const generation=++this.presentationGeneration;this.presentationOutput=true
  this.presentationPlayback={generation,signal,epoch:null,announced:new Set(),claimed:new Set(),started:false,scheduled}
  this.service.setOutputReady(true,false,'presentation')
  let outcome:'completed'|'cancelled'|'failed'='cancelled',failure:unknown
  try{await this.service.speakPresentation(text,signal);outcome=signal.aborted?'cancelled':'completed'}
  catch(e){failure=e;outcome=e instanceof Error&&e.message==='VOICE_CANCELLED'?'cancelled':'failed';throw e}
  finally{
   if(signal.aborted&&signal.reason instanceof Error&&signal.reason.message==='VOICE_PRESENTATION_PREPARATION_TIMEOUT'){outcome='failed';failure=signal.reason}
   if(generation===this.presentationGeneration)await this.stopPresentation(outcome,failure)
  }
 }
 async stopPresentation(outcome:'completed'|'cancelled'|'failed'='cancelled',failure?:unknown){
  const generation=++this.presentationGeneration
  if(this.presentationOutput){
   const pending=this.service.releasePresentationOutput(outcome,failure)
   this.presentationOutput=false;this.presentationPlayback=null
   try{await pending}finally{if(generation===this.presentationGeneration)this.updateOutput()}
  }
 }

 private managementListeners=new Set<()=>void>()
 subscribeManagement(listener:()=>void){this.managementListeners.add(listener);return()=>{this.managementListeners.delete(listener)}}
 get playbackReady(){const win=this.window();return !this.closing&&!!win&&win===this.attached&&!win.isDestroyed()&&!win.webContents.isDestroyed()&&win.isVisible()&&this.rendererReady}
 async manage(value:VoiceManagementAction,owner:BrowserWindow,current:()=>boolean){
  if(!VOICE_MANAGEMENT_ACTIONS.includes(value?.type as any))throw Error('VOICE_ACTION')
  await this.initialize();if(!current())throw Error('CHAT_SETTINGS_EXPIRED')
  if(value.type==='test'&&!this.playbackReady)throw Error('VOICE_OUTPUT_NOT_READY')
  if(value.type==='prepare')return this.service.prepare(true)
  return this.action(value,owner,current)
 }
 private referencePicker:{cancelled:boolean}|null=null
 private picking=false
 private rendererReady=false
 private outputGeneration=0
 private attached:BrowserWindow|null=null
 private closing:Promise<void>|null=null
 private detach:Array<()=>unknown>=[]
 constructor(root:string,worker:string,private window:()=>BrowserWindow|null,private chat:CharacterChatService,private devServerUrl?:string,private petWindow:()=>BrowserWindow|null=()=>null){
  const metrics=process.platform==='win32'?preparationMetrics(root):undefined
  this.service=new CharacterVoiceService(root,worker,()=>chat.snapshot(),s=>this.send(VOICE_IPC.changed,s),e=>this.send(VOICE_IPC.event,e),undefined,value=>{console.info('[voice]',JSON.stringify(value));metrics?.(value)},process.platform==='win32'?new WindowsVoiceInstaller(join(root,'windows-base'),dirname(worker),()=>this.service.refreshBase()):new VoiceBaseInstaller(join(root,'base-model'),join(dirname(worker),'base-native'),()=>this.service.refreshBase()))
  this.service.attachQwenInstaller(new QwenVoiceInstaller(join(root,'qwen-managed'),dirname(worker),()=>this.service.refreshBase()))
  this.service.attachGgufInstaller(new WindowsGgufModelInstaller(join(root,'gguf-models'),()=>this.service.refreshBase()))
  if(process.platform==='win32'&&process.arch==='x64'){
   this.service.attachGpuDetector(async()=>{
    const probe=new RuntimeSupervisor(chat.runtime.binary)
    if(!await probe.available()||!probe.selectedDevice)throw Error('VOICE_GPU_UNAVAILABLE')
    return probe.selectedDevice.backend==='CUDA'?'cuda':'vulkan'
   })
   this.service.requireManagedRuntimeTerms()
   try{
    const pin=(qwenWindowsPolicy as unknown as {managedRuntimeCatalog?:{filename:string;bytes:number;sha256:string}}).managedRuntimeCatalog
    if(!pin)throw Error('GGUF_RUNTIME_ARTIFACT_PENDING')
    if(pin.filename!=='managed-gguf-runtime-catalog.json'||!Number.isSafeInteger(pin.bytes)||pin.bytes<=0||!/^[a-f0-9]{64}$/.test(pin.sha256))throw Error('GGUF_RUNTIME_CHANGED')
    const bytes=readFileSync(join(dirname(worker),pin.filename))
    if(bytes.length!==pin.bytes||createHash('sha256').update(bytes).digest('hex')!==pin.sha256)throw Error('GGUF_RUNTIME_CHANGED')
    const catalog=JSON.parse(bytes.toString('utf8')) as GgufRuntimeCatalog
    this.service.attachManagedRuntimeTerms(new ManagedRuntimeTerms(root,join(dirname(worker),'runtime-terms'),catalog))
    this.service.attachGgufRuntimeInstaller(new WindowsGgufRuntimeInstaller(join(root,'rt',pin.sha256.slice(0,16)),()=>this.service.refreshBase(),{catalog,catalogSha256:pin.sha256,layout:'compact-v1',bundledRoot:join(dirname(worker),'managed-gguf-runtime-archives')}),catalog)
   }catch(error){this.service.runtimeSetupUnavailable(error instanceof Error&&error.message==='GGUF_RUNTIME_ARTIFACT_PENDING'?'GGUF_RUNTIME_ARTIFACT_PENDING':'GGUF_RUNTIME_CHANGED')}
  }
  this.service.attachModelTrash(path=>shell.trashItem(path))
  ipcMain.handle(DOT_IPC.volume,event=>{if(this.closing||!this.petOutput||!isTrustedSender(event,this.petOutput,'pet',this.devServerUrl))throw Error('UNTRUSTED_SENDER');return this.service.snapshot().volume})
  ipcMain.handle(DOT_IPC.voiceAction,async(event,v:VoiceAction)=>{
   if(this.closing||!this.petOutput||!isTrustedSender(event,this.petOutput,'pet',this.devServerUrl)||!v||!['played','scheduled','outputStopped'].includes(v.type)||!this.presentationOutput)throw Error('UNTRUSTED_SENDER')
   const accepted=await this.action(v),run=this.presentationPlayback
   if(v.type==='scheduled'&&accepted===true&&run&&!run.started&&!run.signal.aborted&&run.generation===this.presentationGeneration&&run.epoch===v.epoch&&v.epoch===this.service.snapshot().epoch&&run.claimed.has(v.audioId)&&this.presentationOutput&&this.petReady&&!!this.petOutput?.isVisible()&&!this.petOutput.webContents.isDestroyed()&&!this.playbackReady){run.started=true;run.scheduled(v.delayMs)}
   return {epoch:this.service.snapshot().epoch} // no history/settings projection
  })
  ipcMain.handle(DOT_IPC.audio,(event,id:unknown,epoch:unknown)=>{
   if(this.closing||!this.presentationOutput||!this.petOutput||!isTrustedSender(event,this.petOutput,'pet',this.devServerUrl)||typeof id!=='string'||id.length!==36||!Number.isSafeInteger(epoch))throw Error('UNTRUSTED_AUDIO')
   const bytes=this.service.audio(id,epoch as number),run=this.presentationPlayback
   if(run&&run.generation===this.presentationGeneration&&!run.signal.aborted&&run.epoch===epoch&&run.announced.has(id))run.claimed.add(id)
   return bytes
  })
  const mouth = (event:Electron.IpcMainEvent,value:unknown) => {
   if(!isTrustedSender(event,this.window(),'character-chat',this.devServerUrl)||!validVoiceMouth(value))return
   const state=this.service.snapshot()
   if(value.epoch!==state.epoch||this.presentationOutput||!this.playbackReady)return
   if(value.level&&(this.localAudioEpoch!==value.epoch||!this.localAudioClaims.size||state.volume===0))return
   this.publishMouth(value)
  }
  ipcMain.on(VOICE_MOUTH_IPC,mouth);this.detach.push(()=>ipcMain.removeListener(VOICE_MOUTH_IPC,mouth))
  this.detach.push(chat.subscribeVoiceStart(id=>this.service.requestStarted(id)),chat.subscribeVoice(message=>{if(message)this.service.completed(message);else this.service.cancel()}),chat.subscribe(()=>this.service.onChatChanged()))
  ipcMain.handle(VOICE_IPC.action,async(event,value:VoiceAction)=>{
   if(!isTrustedSender(event,this.window(),'character-chat',this.devServerUrl))throw Error('UNTRUSTED_SENDER')
   const owner=this.window(),generation=this.outputGeneration
   await this.initialize()
   if(owner!==this.window()||generation!==this.outputGeneration||!isTrustedSender(event,this.window(),'character-chat',this.devServerUrl))throw Error('VOICE_OUTPUT_EXPIRED')
   try{await this.action(value,owner,()=>owner===this.window()&&generation===this.outputGeneration&&!!owner&&!owner.isDestroyed())}catch(e){this.service.error(e)}
   return this.service.snapshot()
  })
  ipcMain.handle(VOICE_IPC.audio,(event,id:unknown,epoch:unknown)=>{
   if(!isTrustedSender(event,this.window(),'character-chat',this.devServerUrl)||typeof id!=='string'||id.length!==36||!Number.isSafeInteger(epoch))throw Error('UNTRUSTED_AUDIO')
   const bytes=this.service.audio(id,epoch as number)
   if(this.localAudioEpoch!==epoch){this.localAudioClaims.clear();this.localAudioEpoch=epoch as number}
   this.localAudioClaims.add(id);return bytes
  })
 }
 private publishMouth(value:VoiceMouthInput|null){
  const pet=this.petWindow(),character=this.chat.snapshot().character
  if(pet&&!pet.isDestroyed()&&!pet.webContents.isDestroyed())try{pet.webContents.send(VOICE_MOUTH_IPC,value&&character?{...value,characterId:character.id,revision:character.revision}:null)}catch{}
 }
 private publishManagement(){for(const listener of this.managementListeners){try{listener()}catch{}}}
 private send(channel:string,value:unknown){
  const run=this.presentationPlayback,voice=value as {type?:string;epoch:number;audioId?:string}
  if(this.presentationOutput&&channel===VOICE_IPC.event&&voice.type==='audio'&&voice.audioId&&run&&run.generation===this.presentationGeneration&&!run.signal.aborted){if(run.epoch===null)run.epoch=voice.epoch;if(run.epoch===voice.epoch)run.announced.add(voice.audioId)}
  if(channel===VOICE_IPC.changed){this.publishManagement();const state=value as {epoch:number;status:string;volume:number};if(state.epoch!==this.localAudioEpoch||['off','unavailable','stopped','error'].includes(state.status)){this.localAudioClaims.clear();this.publishMouth(null)}else if(state.volume===0)this.publishMouth(null)}
  if(channel===VOICE_IPC.event&&(value as {type:string}).type==='stop'){this.localAudioClaims.clear();this.publishMouth(null)}
  const win=this.presentationOutput?this.petOutput:this.window()
  if(win&&!win.isDestroyed()&&!win.webContents.isDestroyed()){
   try{win.webContents.send(this.presentationOutput?(channel===VOICE_IPC.event?DOT_IPC.voiceEvent:DOT_IPC.volumeChanged):channel,this.presentationOutput&&channel===VOICE_IPC.changed?(value as any).volume:value)}catch{console.warn('[voice] VOICE_NOTIFICATION_FAILED')}
  }
 }
 attachWindow(win:BrowserWindow){
  ++this.outputGeneration;this.attached=win;this.rendererReady=false;this.service.setOutputReady(false);this.publishManagement()
  const current=()=>this.attached===win
  const deny=()=>{if(current()){this.localAudioClaims.clear();this.publishMouth(null);++this.outputGeneration;this.service.setOutputReady(false);this.publishManagement()}}
  const reset=()=>{if(current()){this.rendererReady=false;deny()}}
  win.on('hide',deny);win.on('close',reset);win.on('closed',reset)
  win.on('show',()=>{if(current())this.updateOutput()})
  win.webContents.on('did-start-loading',reset)
  win.webContents.on('render-process-gone',reset)
  win.webContents.on('destroyed',reset)
 }
 private updateOutput(){
  if(this.presentationOutput&&this.playbackReady){void this.stopPresentation().catch(e=>this.service.error(e));return}
  const win=this.window()
  this.service.setOutputReady(!this.closing&&!!win&&win===this.attached&&!win.isDestroyed()&&!win.webContents.isDestroyed()&&win.isVisible()&&this.rendererReady)
  // Readiness can change without a service snapshot (baseline/off skips preparation).
  this.publishManagement()
 }
 initialize(){return this.initialized??=this.service.initialize()}
 async stop(){try{await this.service.stop()}catch(e){this.service.error(e)}}
 private async action(v:VoiceAction,owner=this.window(),isCurrent=()=>this.window()===owner&&!!owner&&!owner.isDestroyed()){
  if(!v||typeof v!=='object')throw Error('VOICE_ACTION')
  const snapshot=this.chat.snapshot(),character=snapshot.character,context=settingsContext(snapshot)
  const contextCurrent=()=>isCurrent()&&Object.entries(settingsContext(this.chat.snapshot())).every(([key,value])=>context[key as keyof typeof context]===value)
  switch(v.type){
   case 'ready':this.rendererReady=true;this.updateOutput();return
   case 'snapshot':return
   case 'acceptGgufRuntimeTerms':return this.service.acceptManagedRuntimeTerms(v.fingerprint,contextCurrent)
   case 'viewGgufRuntimeTerms':{
    if(!contextCurrent())throw Error('CHAT_SETTINGS_EXPIRED')
    const path=await this.service.runtimeTermsDocument(v.id,v.view)
    if(!contextCurrent())throw Error('CHAT_SETTINGS_EXPIRED')
    if(await shell.openPath(path))throw Error('GGUF_RUNTIME_TERMS_OPEN_FAILED')
    return
   }
   case 'stop':return this.presentationOutput?this.stopPresentation():this.service.stop(true,false)
   case 'installQwen':return this.service.installQwen(contextCurrent)
   case 'cancelInstallQwen':return this.service.cancelInstallQwen()
   case 'installGgufRuntime':case 'repairGgufRuntime':case 'verifyGgufRuntime':{
    if(!['qwen-cuda','qwen-vulkan','vox-cuda','vox-vulkan'].includes(v.id))throw Error('VOICE_ACTION')
    return this.service.setupGgufRuntime(v.id,v.type==='installGgufRuntime'?'install':v.type==='repairGgufRuntime'?'repair':'verify',contextCurrent)
   }
   case 'cancelInstallGgufRuntime':return this.service.cancelInstallGgufRuntime()
   case 'installBase':return this.service.installBase()
   case 'cancelInstallBase':return this.service.cancelInstallBase()
   case 'cancelReferenceImport':if(this.referencePicker)this.referencePicker.cancelled=true;return this.service.cancelReferenceImport()
   case 'prepareVoiceFiles':return this.service.prepareVoiceFiles(contextCurrent)
   case 'cancelPrepareVoiceFiles':return this.service.cancelPrepareVoiceFiles()
   case 'selectVoicePath':return this.service.selectVoicePath(v.id,contextCurrent)
   case 'engine':return this.service.engine(v.value,contextCurrent)
   case 'qwenClone':return this.service.qwenClone(v.value,contextCurrent)
   case 'modelVerification':return this.service.modelVerificationPolicy(v.value,contextCurrent)
   case 'checkModel':return this.service.checkModel(contextCurrent)
   case 'cancelModelCheck':return this.service.cancelModelCheck()
   case 'installGgufModel':case 'verifyGgufModel':if(!['qwen3-tts-06b-gguf','voxcpm2-gguf-f16'].includes(v.id))throw Error('VOICE_ACTION');return v.type==='installGgufModel'?this.service.installGgufModel(v.id,contextCurrent):this.service.verifyGgufModel(v.id,contextCurrent)
   case 'cancelInstallGgufModel':return this.service.cancelInstallGgufModel()
   case 'refreshManagedModels':return this.service.refreshManagedModels(contextCurrent)
   case 'removeManagedModel':{
    if(!['voxcpm2-base','qwen3-tts-06b','qwen3-tts-06b-gguf','voxcpm2-gguf-f16'].includes(v.id))throw Error('VOICE_ACTION')
    const win=owner;if(!win||win.isDestroyed()||this.picking)return
    this.picking=true
    const selection=this.service.modelRemovalContext()
    const current=()=>!this.closing&&contextCurrent()&&!win.isDestroyed()&&this.service.modelRemovalContext()===selection
    try{
     if(!current())return
     const plan=await this.service.inspectManagedModelRemoval(v.id,current)
     if(!plan||!current())return
     const bytes=(value:number)=>value.toLocaleString(appLanguage()==='en'?'en-US':'ko-KR')+' bytes'
     const detail=[appText('모델')+': '+plan.modelId,appText('고정 버전')+': '+plan.revision,appText('삭제 용량')+': '+bytes(plan.totalBytes),...plan.directories.map(directory=>directory.path+'\n'+bytes(directory.bytes)),appText(this.service.modelRemovalImpact(plan)?'현재 목소리가 이 모델을 사용합니다. 삭제 후에는 필요한 모델을 다시 받고 연결해야 합니다.':'현재 선택한 목소리는 이 모델을 사용하지 않습니다.'),appText('휴지통을 비우기 전까지 저장 공간을 계속 사용합니다. 복원 후 다시 연결할 수 있습니다.'),appText('현재 음성과 해당 모델 다운로드를 중단합니다. 모델 파일과 모델 다운로드 캐시만 휴지통으로 옮깁니다. Python·실행 환경, 캐릭터 목소리 선택, 학습팩, 기준 WAV와 외부 모델은 보존됩니다.')].join('\n\n')
     const result=await dialog.showMessageBox(win,{type:'warning',buttons:[appText('취소'),appText('휴지통으로 이동')],defaultId:0,cancelId:0,message:appText('앱이 관리하는 음성 모델을 휴지통으로 옮길까요?'),detail})
     if(result.response===1&&current())await this.service.removeManagedModel(v.id,plan.planId,current)
    }finally{this.picking=false}
    return
   }
   case 'prepare':return this.service.prepare()
   case 'gpuBackend':return this.service.gpuBackend(v.value,contextCurrent)
   case 'executionProfile':if(!this.service.snapshot().availableProfiles?.includes(v.value))throw Error('VOICE_ACTION');return this.service.executionProfile(v.value)
   case 'enabled':case 'auto':if(typeof v.value!=='boolean')throw Error('VOICE_ACTION');return v.type==='enabled'?this.service.enabled(v.value):this.service.auto(v.value)
   case 'volume':if(!Number.isFinite(v.value)||v.value<0||v.value>1)throw Error('VOICE_ACTION');return this.service.volume(v.value)
   case 'bind':if(!character||v.profile!==null&&(typeof v.profile!=='string'||v.profile.length>170))throw Error('VOICE_ACTION');return this.service.bind(character.id,v.profile,contextCurrent)
   case 'renameReference':if(typeof v.profile!=='string'||v.profile.length>170||typeof v.name!=='string'||v.name.length>80)throw Error('VOICE_ACTION');return this.service.renameReference(v.profile,v.name,contextCurrent)
   case 'remove':{
    if(typeof v.profile!=='string'||v.profile.length>170)throw Error('VOICE_ACTION')
    const state=this.service.snapshot(),profile=state.profiles.find(p=>p.id+'@'+p.version===v.profile)
    if(isReferenceProfile(profile)){
     if(!owner||owner.isDestroyed())throw Error('VOICE_ACTION')
     const count=Object.values(state.bindings).filter(key=>key===v.profile).length
     const result=await dialog.showMessageBox(owner,{type:'question',buttons:[appText('취소'),appText('삭제')],defaultId:0,cancelId:0,message:appText('WAV 음성을 삭제할까요?'),detail:appLanguage()==='en'?`${count} character voice binding(s) will be removed. Active speech will stop. The original WAV will be kept.`:`연결된 캐릭터 ${count}개의 음성 연결이 해제됩니다. 현재 발화를 중단하며, 원본 WAV는 삭제하지 않습니다.`})
     if(result.response!==1||!contextCurrent())return
    }
    return this.service.remove(v.profile)
   }
   case 'importReference':{
    if(typeof v.name!=='string'||!v.name.trim()||v.name.trim().length>80||/[\x00-\x1f\x7f]/.test(v.name)||v.acknowledged!==true)throw Error('VOICE_REFERENCE_NAME')
    const win=owner;if(!win||win.isDestroyed()||this.referencePicker||this.picking)return
    const pick={cancelled:false};this.referencePicker=pick;this.picking=true
    try{
     const r=await dialog.showOpenDialog(win,{title:appText('기준 WAV 선택'),filters:[{name:'WAV',extensions:['wav']}],properties:process.platform==='darwin'?['openFile','noResolveAliases']:['openFile']})
     if(!pick.cancelled&&contextCurrent()&&!win.isDestroyed()&&!r.canceled&&r.filePaths.length===1)await this.service.importReference(r.filePaths[0],v.name,()=>!pick.cancelled&&contextCurrent()&&!win.isDestroyed())
    }finally{if(this.referencePicker===pick){this.referencePicker=null;this.picking=false}}
    return
   }
   case 'seedSettings':return this.service.seedSettings(v.value,contextCurrent)
   case 'replay':case 'reroll':case 'reproduce':if(typeof v.messageId!=='string'||v.messageId.length>80)throw Error('VOICE_ACTION');return this.service.readMessage(v.messageId,v.type)
   case 'read':if(typeof v.messageId!=='string'||v.messageId.length>80)throw Error('VOICE_ACTION');return this.service.readMessage(v.messageId)
   case 'test':return this.service.test()
   case 'played':if(!this.presentationOutput&&v.epoch===this.localAudioEpoch){this.localAudioClaims.delete(v.audioId);if(!this.localAudioClaims.size)this.publishMouth(null)}if(typeof v.audioId!=='string'||v.audioId.length!==36||!Number.isSafeInteger(v.epoch)||v.error!==undefined&&typeof v.error!=='boolean')throw Error('VOICE_ACTION');return this.service.played(v.audioId,v.epoch,v.error)
   case 'scheduled':if(typeof v.audioId!=='string'||v.audioId.length!==36||!Number.isSafeInteger(v.epoch)||!Number.isFinite(v.delayMs)||v.delayMs<0||v.delayMs>6000||!Number.isFinite(v.gapMs)||v.gapMs<0||v.gapMs>180_000)throw Error('VOICE_ACTION');return this.service.scheduled(v.audioId,v.epoch,v.delayMs,v.gapMs)
   case 'outputStopped':if(!Number.isSafeInteger(v.epoch)||!Number.isFinite(v.elapsedMs)||v.elapsedMs<0||v.elapsedMs>180_000)throw Error('VOICE_ACTION');return this.service.outputStopped(v.epoch,v.elapsedMs)
   case 'configureQwenGguf':{
    if(process.platform!=='win32'||process.arch!=='x64')throw Error('QWEN_GGUF_UNSUPPORTED')
    const win=owner;if(!win||win.isDestroyed()||this.picking)return
    this.picking=true
    const current=()=>!this.closing&&contextCurrent()&&!win.isDestroyed()
    try{
     if(!current())return
     const python=await dialog.showOpenDialog(win,{title:appText('Qwen GGUF 환경의 Python 선택'),properties:['openFile']})
     if(!current()||python.canceled||python.filePaths.length!==1||!python.filePaths[0])return
     const runtime=await dialog.showOpenDialog(win,{title:appText(this.service.snapshot().executionProfile?.startsWith('qwen-gguf-vulkan')?'검증된 Qwen GGUF Vulkan DLL 폴더 선택':'검증된 Qwen GGUF CUDA DLL 폴더 선택'),properties:['openDirectory']})
     if(!current()||runtime.canceled||runtime.filePaths.length!==1||!runtime.filePaths[0])return
     const model=await dialog.showOpenDialog(win,{title:appText('Qwen 0.6B Base Q8·codec Q8 모델 폴더 선택'),properties:['openDirectory']})
     if(!current()||model.canceled||model.filePaths.length!==1||!model.filePaths[0])return
     await this.service.configureQwenGguf(python.filePaths[0],model.filePaths[0],runtime.filePaths[0],current)
    }finally{this.picking=false}
    return
   }
   case 'configureVoxGguf':{
    if(process.platform!=='win32'||process.arch!=='x64')throw Error('VOX_GGUF_UNSUPPORTED')
    const win=owner;if(!win||win.isDestroyed()||this.picking)return
    this.picking=true
    const current=()=>!this.closing&&contextCurrent()&&!win.isDestroyed()
    const state=this.service.snapshot(),key=state.bindings[character?.id||'']||state.defaultProfile,publicBase=isManagedVoice(state.profiles.find(profile=>profile.id+'@'+profile.version===key))
    const pick=async(options:Electron.OpenDialogOptions)=>{
     if(!current())return null
     const result=await dialog.showOpenDialog(win,options)
     return current()&&!result.canceled&&result.filePaths.length===1&&result.filePaths[0]?result.filePaths[0]:null
    }
    try{
     const python=await pick({title:appText('VoxCPM2 Windows GGUF 환경의 Python 선택'),properties:['openFile']});if(!python)return
     const model=await pick({title:appText(publicBase?'공개 VoxCPM2 F16 GGUF 모델 폴더 선택':'고정 원본 VoxCPM2 모델 폴더 선택'),properties:['openDirectory']});if(!model)return
     const runtimeDir=await pick({title:appText('검증된 VoxCPM2 Windows EXE·DLL 폴더 선택'),properties:['openDirectory']});if(!runtimeDir)return
     const derivativeDir=publicBase?model:await pick({title:appText('변환 기록과 BaseLM·Acoustic F16 GGUF 폴더 선택'),properties:['openDirectory']});if(!derivativeDir)return
     const receipt=await pick({title:appText('VoxCPM2 Windows GGUF 실행 승인 기록 선택'),filters:[{name:'JSON',extensions:['json']}],properties:['openFile']});if(!receipt)return
     await (publicBase?this.service.configureVoxPublicGguf(python,model,{runtimeDir,derivativeDir,receipt},current):this.service.configureVoxGguf(python,model,{runtimeDir,derivativeDir,receipt},current))
    }finally{this.picking=false}
    return
   }
   case 'import':case 'configure':case 'configureQwen':{
    const win=owner;if(!win||win.isDestroyed()||this.picking)return
    this.picking=true
    const current=()=>isCurrent()&&!win.isDestroyed()
    try{
     if(v.type==='import'){
      const r=await dialog.showOpenDialog(win,{title:process.platform==='darwin'?'LoRA 음성 패키지 폴더 가져오기':'채택된 음성 패키지 폴더 가져오기',properties:['openDirectory']})
      if(current()&&!r.canceled&&r.filePaths[0])await this.service.importPackage(r.filePaths[0])
     }else{
      const python=await dialog.showOpenDialog(win,{title:'독립 TTS 환경의 Python 선택',properties:process.platform==='darwin'?['openFile','noResolveAliases']:['openFile']})
      if(!current()||python.canceled||!python.filePaths[0])return
      const model=await dialog.showOpenDialog(win,{title:v.type==='configureQwen'?'고정 Qwen3-TTS 0.6B 로컬 모델 폴더 선택':'고정 VoxCPM2 로컬 모델 폴더 선택',properties:['openDirectory']})
      if(current()&&!model.canceled&&model.filePaths[0])await (v.type==='configureQwen'?this.service.configureQwen(python.filePaths[0],model.filePaths[0],contextCurrent):this.service.configure(python.filePaths[0],model.filePaths[0]))
     }
    }finally{this.picking=false}
    return
   }
   default:throw Error('VOICE_ACTION')
  }
 }
 close():Promise<void>{
  if(this.closing)return this.closing
  this.rendererReady=false
  this.petReady=false;this.petOutput=null;this.presentationOutput=false;this.presentationPlayback=null;++this.presentationGeneration
  for(const off of this.presentationDetach.splice(0))off()
  this.publishMouth(null)
  if(this.referencePicker)this.referencePicker.cancelled=true
  this.managementListeners.clear()
  const work=[()=>ipcMain.removeHandler(DOT_IPC.volume),()=>ipcMain.removeHandler(DOT_IPC.voiceAction),()=>ipcMain.removeHandler(DOT_IPC.audio),()=>ipcMain.removeHandler(VOICE_IPC.action),()=>ipcMain.removeHandler(VOICE_IPC.audio),...this.detach,()=>this.service.close()]
  this.detach=[]
  this.closing=Promise.allSettled(work.map(fn=>Promise.resolve().then(fn))).then(results=>{
   if(results.some(r=>r.status==='rejected'))throw Error('VOICE_CLOSE_FAILED')
  })
  return this.closing
 }
}
