import {isGpuBackendPreference,type GpuBackendPreference} from '../../shared/gpu-backend'
import {voiceProfileBackend,voiceBackendProfile,canRetryVoiceWithVulkan} from '../../shared/voice-gpu-backend'
import {defaultVoiceSetup,voiceSetupPaths,currentVoiceSetupPath,isLegacyVoiceModel,type VoiceSetupPathId} from '../../shared/voice-setup-paths'
import type {WindowsGgufModelInstallation} from './WindowsGgufModelInstaller'
import type {WindowsGgufRuntimeInstallation} from './WindowsGgufRuntimeInstaller'
import type {GgufRuntimeId,GgufRuntimeCatalog,GgufRuntimeConnection} from '../../shared/windows-gguf-runtime-catalog'
import {GGUF_MODEL_CATALOG,type GgufModelId} from '../../shared/windows-gguf-model-catalog'
import type {ManagedVoiceModelRemoval} from '../../shared/character-voice-contract'
import type {QwenInstallation} from './QwenVoiceInstaller'
import {DEFAULT_VOICE_SEED,validSeedSettings,validVoiceSeed,type VoiceSeedSettings,type VoiceGenerationPlan} from '../../shared/voice-seed'
import {VoiceReplayCache,type ReplayCandidate} from './VoiceReplayCache'
import {VoiceAssetIdentity} from './VoiceAssetIdentity'
import {mkdir,readdir,readFile,rm,writeFile,realpath} from 'node:fs/promises'
import {dirname,join,relative,isAbsolute,sep} from 'node:path'
import {createHash,randomUUID,randomInt} from 'node:crypto'
import type {ChatMessage,LocalChatSnapshot} from '../../shared/character-chat-contract'
import {isManagedVoice,isReferenceProfile,isQwenEngine,isWindowsVoxGgufProfile,DEFAULT_SPEECH_POLICY,planSpeech,type SpeechPolicy,isStreamingProfile,voiceCapabilities,type SpeechBinding,type PlaybackBinding,type VoiceEvent,type VoiceSnapshot,type ExecutionProfile} from '../../shared/character-voice-contract'
import {importVoicePackage,profileKey,SELECTED_VOICE,verifyVoicePackage} from './VoicePackage'
import {TtsRuntimeSupervisor,type TtsConfig,type AudioChunk} from './TtsRuntimeSupervisor'
import {verifyMacInterpreter} from './VoiceRuntimeProfile'
import {type BaseVoiceInstallation,BASE_VOICE,BASE_KEY} from './VoiceBaseInstaller'
import {ReferenceProfileStore,referenceKey,workerReferenceConverter,type ReferenceCondition} from './ReferenceProfileStore'
import {checkWindowsModel} from './WindowsModelCheck'
import {replaceFile} from '../character-chat/replaceFile'
import type {ManagedRuntimeTerms} from './ManagedRuntimeTerms'
import type {RuntimeTermsView} from '../../shared/managed-runtime-terms'
type ManagedRuntimeFields=Pick<TtsConfig,'managedRuntime'|'dependencyDirs'>
type VoxGgufConnection={python:string;model:string;gguf:{runtimeDir:string;derivativeDir:string;receipt:string}}&ManagedRuntimeFields
type QwenGgufConnection={python:string;model:string;ggufRuntime:string}&ManagedRuntimeFields
type VoiceOutputOwner='local'|'presentation'

export class CharacterVoiceService {
 private state:VoiceSnapshot={gpuBackend:'auto',seedSettings:{...DEFAULT_VOICE_SEED},seedError:false,engine:defaultVoiceSetup(process.platform,process.arch).engine,qwenClone:{mode:'x-vector',transcript:''},epoch:0,enabled:false,autoRead:true,volume:0.8,profiles:[],bindings:{},status:'off',error:null,runtimeConfigured:false,availableProfiles:voiceCapabilities(process.platform,process.arch),executionProfile:process.platform==='darwin'?'gguf-metal-f16':process.platform==='win32'&&process.arch==='x64'?'gguf-cuda-f16':'baseline'}
 private automaticBackend:'cuda'|'vulkan'='cuda'
 private detectGpu:(()=>Promise<'cuda'|'vulkan'>)|undefined
 attachGpuDetector(detect:()=>Promise<'cuda'|'vulkan'>){this.detectGpu=detect}
 private replay=new VoiceReplayCache()
 readonly references:ReferenceProfileStore
 private referenceOperation:{controller:AbortController;task:Promise<void>}|null=null
 private referenceImportError:string|null=null
 private ggufInstaller?:WindowsGgufModelInstallation
 private installingGguf:Promise<void>|null=null
 private installingGgufId:GgufModelId|null=null
 private ggufInstallEpoch=0
 private ggufRuntimeInstaller?:WindowsGgufRuntimeInstallation
 private ggufRuntimeCatalog?:GgufRuntimeCatalog
 private ggufRuntimeTerms?:ManagedRuntimeTerms
 private runtimeTermsRequired=false
 private filePreparationTask:Promise<void>|null=null
 private filePreparationEpoch=0
 private runtimeSetupTask:Promise<void>|null=null
 private runtimeSetupId:GgufRuntimeId|null=null
 private runtimeSetupEpoch=0
 private runtimeCancelTask:Promise<void>|null=null
 private managedTask:Promise<unknown>|null=null
 private modelTrash?:((path:string)=>Promise<void>)
 private qwenInstaller?:QwenInstallation
 private installingQwen:Promise<void>|null=null
 private qwenInstallEpoch=0
 private qwenSettingsEpoch=0
 private qwenApplicationDeferred=false
 private installingBase:Promise<void>|null=null
 private installEpoch=0
 private baseExecutionProfile:ExecutionProfile=process.platform==='win32'&&process.arch==='x64'?'gguf-cuda-f16':'cuda-compiled'
 private verifiedBase:{runtime:TtsRuntimeSupervisor;session:string;key:string;identity:string}|null=null
 private qwenExecutionProfile:ExecutionProfile='qwen-mlx'
 private qwenSupported(){return process.platform==='win32'||process.platform==='darwin'&&process.arch==='arm64'}
 private qwenConfig:{python:string;model:string}|null=null
 private qwenGgufConfig:({python:string;model:string;ggufRuntime:string;ggufVulkanRuntime?:string;ggufVulkanManagedRuntime?:GgufRuntimeConnection['managedRuntime'];ggufVulkanDependencyDirs?:string[]}&ManagedRuntimeFields)|null=null
 private qwenGgufBackends:Partial<Record<'cuda'|'vulkan',QwenGgufConnection>>={}
 private qwenGgufExecutionProfile:ExecutionProfile='qwen-gguf'
 private qwenGgufSupported(){return process.platform==='win32'&&process.arch==='x64'}
 private qwenConnection(){if(this.state.engine!=='qwen3-tts-06b-gguf')return this.qwenConfig;const c=this.qwenGgufConfig,vulkan=this.activeProfile().includes('-vulkan'),cached=this.qwenGgufBackends[vulkan?'vulkan':'cuda'],runtime=vulkan?c?.ggufVulkanRuntime:c?.ggufRuntime;return cached??(c&&runtime?{python:c.python,model:c.model,ggufRuntime:runtime,...(vulkan?{managedRuntime:c.ggufVulkanManagedRuntime,dependencyDirs:c.ggufVulkanDependencyDirs}:{managedRuntime:c.managedRuntime,dependencyDirs:c.dependencyDirs})}:null)}
 private voxGgufConfig:VoxGgufConnection|null=null
 private voxTrainedGgufBackends:Partial<Record<'cuda'|'vulkan',VoxGgufConnection>>={}
 private voxPublicGgufConfig:VoxGgufConnection|null=null
 private voxPublicGgufBackends:Partial<Record<'cuda'|'vulkan',VoxGgufConnection>>={}
 private voxGgufConnection(){const backend=this.activeProfile().includes('vulkan')?'vulkan':'cuda';return isManagedVoice(this.selectedProfile())?this.voxPublicGgufBackends[backend]??this.voxPublicGgufConfig:this.voxTrainedGgufBackends[backend]??this.voxGgufConfig}
 private config:{python:string;model:string}|null=null
 private modelVerification:'full'|'installed'='full'
 private modelCheckController:AbortController|null=null
 private modelCheckTask:Promise<void>|null=null
 private blockedModels=new Set<string>()
 private runtime:TtsRuntimeSupervisor|null=null
 private runtimeStartTask:Promise<void>=Promise.resolve()
 private runtimeOwners:{runtime:TtsRuntimeSupervisor;session:string;owners:Set<VoiceOutputOwner>}|null=null
 private serial:Promise<unknown>=Promise.resolve()
 private operation=0
 private seen=new Set<string>()
 private active:{id:string;epoch:number;bytes:Uint8Array;claimed:boolean;resolve:()=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}|null=null
 private outputReady=false
 private outputOwner:VoiceOutputOwner='local'
 private presentationMuted=false
 private speechOwner:VoiceOutputOwner='local'
 private observedRequests=new Set<string>()
 private allowedRequests=new Set<string>()
 private pendingRemoval=new Set<string>()
 private disposed=false
 private currentSpeech:(()=>boolean)|null=null
 private speechHandoffs=0
 private preparing:Promise<void>|null=null
 private preparationCurrent:(()=>boolean)|null=null
 private chunks=new Map<string,{epoch:number;bytes:Uint8Array;durationMs:number;claimed:boolean;resolve:()=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>;segmentIndex:number;chunkIndex:number}>()
 private speechStartedAt=0
 private requestTimes=new Map<string,number>()
 private spokenRequestAt=0
 private firstPlayback=false
 private lastPlaybackEndAt=0
 constructor(readonly root:string,private worker:string,private chat:()=>LocalChatSnapshot,private changed:(state:VoiceSnapshot)=>void,private event:(event:VoiceEvent)=>void,private makeRuntime:(config:TtsConfig)=>TtsRuntimeSupervisor=config=>new TtsRuntimeSupervisor(config),private diagnostic:(value:Record<string,unknown>)=>void=()=>{},private base?:BaseVoiceInstallation,private speechPolicy:SpeechPolicy=DEFAULT_SPEECH_POLICY,referenceStore?:ReferenceProfileStore,private chooseRandom:()=>number=()=>randomInt(1,0x80000000)){this.references=referenceStore??new ReferenceProfileStore(join(root,'reference-profiles'),workerReferenceConverter(join(dirname(worker),'reference-import-worker.cjs')))}
 attachQwenInstaller(installer:QwenInstallation){this.qwenInstaller=installer}
 attachGgufInstaller(installer:WindowsGgufModelInstallation){this.ggufInstaller=installer}
 attachGgufRuntimeInstaller(installer:WindowsGgufRuntimeInstallation,catalog:GgufRuntimeCatalog){this.ggufRuntimeInstaller=installer;this.ggufRuntimeCatalog=catalog}
 requireManagedRuntimeTerms(){this.runtimeTermsRequired=true}
 attachManagedRuntimeTerms(terms:ManagedRuntimeTerms){this.runtimeTermsRequired=true;this.ggufRuntimeTerms=terms}
 private assertRuntimeTerms(){if(this.runtimeTermsRequired){if(!this.ggufRuntimeTerms)throw Error('GGUF_RUNTIME_TERMS_CHANGED');this.ggufRuntimeTerms.assertAccepted()}}
 private assertConfiguredRuntimeTerms(){
  const config=isQwenEngine(this.state.engine)?this.qwenConnection():isWindowsVoxGgufProfile(this.activeProfile())?this.voxGgufConnection():isManagedVoice(this.selectedProfile())?this.base&&{python:this.base.executable}:this.config
  if(!config)return
  const prefix=relative(join(this.root,'rt'),config.python),owned=prefix!==''&&prefix!=='..'&&!prefix.startsWith('..'+sep)&&!isAbsolute(prefix)
  if(('managedRuntime' in config&&config.managedRuntime)||owned)this.assertRuntimeTerms()
 }
 acceptManagedRuntimeTerms(fingerprint:string,current=()=>true){
  const id=this.selectedGgufRuntimeId(),terms=this.ggufRuntimeTerms
  if(!id||!terms||typeof fingerprint!=='string')return Promise.reject(Error('VOICE_ACTION'))
  const task=this.serial.then(async()=>{if(this.disposed||!current()||id!==this.selectedGgufRuntimeId())throw Error('CHAT_SETTINGS_EXPIRED');await terms.accept(fingerprint,()=>!this.disposed&&current()&&id===this.selectedGgufRuntimeId());this.emit()});this.serial=task.catch(()=>{});return task
 }
 runtimeTermsDocument(id:string,view:RuntimeTermsView){const runtime=this.selectedGgufRuntimeId();if(!runtime||!this.ggufRuntimeTerms)throw Error('VOICE_ACTION');return this.ggufRuntimeTerms.document(id,view,runtime)}
 runtimeSetupUnavailable(error:string){this.state.ggufRuntimeSetup={busy:false,error}}
 attachModelTrash(trashItem:(path:string)=>Promise<void>){this.modelTrash=trashItem}
 private assertModelsAvailable(runtimeOwner=false){if(this.managedTask)throw Error('VOICE_MODEL_REMOVAL_BUSY');if(this.runtimeCancelTask||this.runtimeSetupTask&&!runtimeOwner)throw Error('GGUF_RUNTIME_BUSY')}
 private managedInstaller(id:ManagedVoiceModelRemoval['id']){
  if(id==='qwen3-tts-06b')return this.qwenInstaller
  if(id==='voxcpm2-base')return this.base
  if(id==='qwen3-tts-06b-gguf'||id==='voxcpm2-gguf-f16')return this.ggufInstaller?{modelRemoval:()=>this.ggufInstaller!.modelRemoval(id),removeModel:(plan:string,trash:(path:string)=>Promise<void>)=>this.ggufInstaller!.removeModel(id,plan,trash)}:undefined
  throw Error('VOICE_ACTION')
 }
 private async managedPlans(){const plans:ManagedVoiceModelRemoval[]=[];for(const id of ['voxcpm2-base','qwen3-tts-06b','qwen3-tts-06b-gguf','voxcpm2-gguf-f16'] as const){const value=await this.managedInstaller(id)?.modelRemoval?.();if(value)plans.push({...value,currentVoiceAffected:this.modelRemovalImpact(value),legacy:isLegacyVoiceModel(value.id,process.platform)})}return plans}
 private manageModels<T>(work:()=>Promise<T>,release=true):Promise<T>{
  if(this.managedTask||!release&&(this.speechHandoffs||this.preparing||this.currentSpeech||this.installingBase||this.installingQwen||this.installingGguf||this.runtimeSetupTask||this.runtimeCancelTask||this.modelCheckTask||this.filePreparationTask))return Promise.reject(Error('VOICE_MODEL_REMOVAL_BUSY'))
  const task:Promise<T>=Promise.resolve().then(async()=>{
   this.state.managedModelRemoval={busy:true,error:null};this.emit()
   // Cancel outside serial: a download may be waiting on its own queued apply.
   if(release)await Promise.all([this.cancelPrepareVoiceFiles(),this.cancelInstallBase(),this.cancelInstallQwen(),this.cancelInstallGgufModel(),this.cancelInstallGgufRuntime(),this.cancelModelCheck()])
   const action=this.serial.then(async()=>{if(release)await this.stop();if(this.disposed)throw Error('CHAT_SETTINGS_EXPIRED');return work()});this.serial=action.catch(()=>{});return action
  }).catch(e=>{this.state.managedModels=[];this.state.managedModelRemoval={busy:true,error:e instanceof Error&&/^[A-Z_]+$/.test(e.message)?e.message:'VOICE_MODEL_REMOVAL_FAILED'};throw e})
   .finally(()=>{if(this.managedTask===task){this.managedTask=null;if(this.state.managedModelRemoval)this.state.managedModelRemoval.busy=false;this.emit()}})
  this.managedTask=task;return task
 }
 refreshManagedModels(current=()=>true){return this.manageModels(async()=>{if(!current())throw Error('CHAT_SETTINGS_EXPIRED');this.state.managedModels=await this.managedPlans();if(!current()){this.state.managedModels=[];throw Error('CHAT_SETTINGS_EXPIRED')}},false)}
 inspectManagedModelRemoval(id:ManagedVoiceModelRemoval['id'],current=()=>true){return this.manageModels(async()=>{if(!current())throw Error('CHAT_SETTINGS_EXPIRED');const plan=await this.managedInstaller(id)?.modelRemoval?.();if(!current())throw Error('CHAT_SETTINGS_EXPIRED');if(!plan)throw Error('VOICE_MODEL_REMOVAL_CHANGED');return {...plan,currentVoiceAffected:this.modelRemovalImpact(plan),legacy:isLegacyVoiceModel(plan.id,process.platform)}},false)}
 removeManagedModel(id:ManagedVoiceModelRemoval['id'],planId:string,current=()=>true){return this.manageModels(async()=>{
  if(!current())throw Error('CHAT_SETTINGS_EXPIRED');const installer=this.managedInstaller(id);if(!installer?.removeModel||!this.modelTrash)throw Error('VOICE_MODEL_REMOVAL_FAILED')
  const plan=await installer.modelRemoval?.();if(!plan||plan.planId!==planId)throw Error('VOICE_MODEL_REMOVAL_CHANGED')
  const affected=this.modelRemovalImpact(plan);await installer.removeModel(planId,this.modelTrash);this.disconnectRemovedModels(plan);if(affected)this.state.filePreparation=undefined;await this.save();this.verifiedBase=null;this.runtime=null;this.state.lastGeneration=undefined;this.replay.clear()
  this.state.managedModels=await this.managedPlans();this.state.status=this.state.enabled?(this.configured()?'idle':'unavailable'):'off';this.state.error=null
 })}
 installGgufModel(id:GgufModelId,current=()=>true):Promise<void>{
  if(this.runtimeSetupTask)return Promise.reject(Error('GGUF_RUNTIME_BUSY'))
  if(this.managedTask)return Promise.reject(Error('VOICE_MODEL_REMOVAL_BUSY'))
  if(this.installingGguf)return this.installingGgufId===id?this.installingGguf:Promise.reject(Error('GGUF_MODEL_BUSY'))
  if(!this.ggufInstaller||!this.qwenGgufSupported())return Promise.reject(Error('GGUF_MODEL_UNSUPPORTED'))
  const epoch=this.ggufInstallEpoch,qwenConnection=this.qwenGgufConfig,qwenBackends={...this.qwenGgufBackends},voxConnection=this.voxPublicGgufConfig,voxBackends={...this.voxPublicGgufBackends}
  const task:Promise<void>=Promise.resolve().then(async()=>{
   if(this.disposed||epoch!==this.ggufInstallEpoch||!current())return
   const connection=await this.ggufInstaller!.install(id)
   if(!connection||this.disposed||epoch!==this.ggufInstallEpoch||!current())return
   await this.mutate(async()=>{
    if(epoch!==this.ggufInstallEpoch||!current())return;await this.stop();if(!current())return
    if(id==='qwen3-tts-06b-gguf'&&this.qwenGgufConfig===qwenConnection){if(this.qwenGgufConfig)this.qwenGgufConfig={...this.qwenGgufConfig,model:connection.model};for(const backend of ['cuda','vulkan'] as const)if(this.qwenGgufBackends[backend]&&this.qwenGgufBackends[backend]===qwenBackends[backend])this.qwenGgufBackends[backend]={...this.qwenGgufBackends[backend]!,model:connection.model}}
    if(id==='voxcpm2-gguf-f16'&&this.voxPublicGgufConfig===voxConnection){if(this.voxPublicGgufConfig)this.voxPublicGgufConfig={...this.voxPublicGgufConfig,model:connection.model,gguf:{...this.voxPublicGgufConfig.gguf,derivativeDir:connection.model}};for(const backend of ['cuda','vulkan'] as const){const value=this.voxPublicGgufBackends[backend];if(value&&value===voxBackends[backend])this.voxPublicGgufBackends[backend]={...value,model:connection.model,gguf:{...value.gguf,derivativeDir:connection.model}}}}
    this.runtime=null;this.state.error=null
   })
  }).finally(()=>{if(this.installingGguf===task){this.installingGguf=null;this.installingGgufId=null;this.emit()}})
  this.installingGguf=task;this.installingGgufId=id;return task
 }
 async cancelInstallGgufModel(){++this.ggufInstallEpoch;await this.ggufInstaller?.cancel();await this.installingGguf?.catch(()=>{})}
 verifyGgufModel(id:GgufModelId,current=()=>true){return this.manageModels(async()=>{if(!current())throw Error('CHAT_SETTINGS_EXPIRED');if(!this.ggufInstaller)throw Error('GGUF_MODEL_UNSUPPORTED');await this.ggufInstaller.verify(id);if(!current())throw Error('CHAT_SETTINGS_EXPIRED');this.emit()})}
 private selectedGgufRuntimeId():GgufRuntimeId|undefined{const p=this.activeProfile();return this.state.engine==='qwen3-tts-06b-gguf'?p.includes('vulkan')?'qwen-vulkan':'qwen-cuda':isWindowsVoxGgufProfile(p)?p.includes('vulkan')?'vox-vulkan':'vox-cuda':undefined}
 private managedAdmission<T extends {python:string;ggufRuntime?:string;gguf?:{runtimeDir:string;receipt:string};managedRuntime?:GgufRuntimeConnection['managedRuntime'];dependencyDirs?:string[]}>(config:T){
  if(!config.managedRuntime)return config
  return {...config,beforeManagedSpawn:async()=>{
   this.assertRuntimeTerms()
   if(this.disposed||this.managedTask||this.runtimeSetupTask||this.runtimeCancelTask)throw Error('GGUF_RUNTIME_BUSY')
   if(config.managedRuntime!.runtimeId!==this.selectedGgufRuntimeId())throw Error('GGUF_RUNTIME_ADMISSION')
   if(!this.ggufRuntimeInstaller)throw Error('GGUF_RUNTIME_ADMISSION')
   const fresh=await this.ggufRuntimeInstaller.verify(config.managedRuntime!.runtimeId)
   if(this.disposed||this.managedTask||this.runtimeSetupTask||this.runtimeCancelTask||config.managedRuntime!.runtimeId!==this.selectedGgufRuntimeId()||fresh.python!==config.python||fresh.runtimeDir!==(config.ggufRuntime??config.gguf?.runtimeDir)||config.gguf&&fresh.receipt!==config.gguf.receipt||JSON.stringify(fresh.managedRuntime)!==JSON.stringify(config.managedRuntime)||JSON.stringify(fresh.dependencyDirs)!==JSON.stringify(config.dependencyDirs))throw Error('GGUF_RUNTIME_CHANGED')
  }}
 }
 private async applyGgufRuntime(connection:GgufRuntimeConnection,current:()=>boolean){
  if(!current()){this.state.ggufRuntimeSetup!.application='deferred';return}
  const trained=connection.id.startsWith('vox')&&!isManagedVoice(this.selectedProfile())
  const trainedConnection=trained?this.voxGgufConnection():null
  const modelId:GgufModelId=connection.id.startsWith('qwen')?'qwen3-tts-06b-gguf':'voxcpm2-gguf-f16'
  const installed=this.ggufInstaller?.snapshot().find(s=>s.id===modelId&&s.installed&&s.modelPath)
  if(trained?!trainedConnection:!installed){this.state.ggufRuntimeSetup!.application='model-required';return}
  const model=trained?trainedConnection!.model:await this.ggufInstaller!.verify(modelId)
  await this.mutate(async()=>{
   if(!current()){this.state.ggufRuntimeSetup!.application='deferred';return}
   const fields={managedRuntime:{...connection.managedRuntime},dependencyDirs:[...connection.dependencyDirs]}
   if(connection.id.startsWith('qwen')){
    const prior=this.qwenGgufConfig??{python:connection.python,model,ggufRuntime:''}
    this.qwenGgufConfig=connection.id==='qwen-vulkan'?{...prior,python:connection.python,model,ggufVulkanRuntime:connection.runtimeDir,ggufVulkanManagedRuntime:fields.managedRuntime,ggufVulkanDependencyDirs:fields.dependencyDirs}:{...prior,python:connection.python,model,ggufRuntime:connection.runtimeDir,...fields}
    this.qwenGgufBackends[connection.id==='qwen-vulkan'?'vulkan':'cuda']={python:connection.python,model,ggufRuntime:connection.runtimeDir,...fields}
   }else{
    if(!connection.receipt)throw Error('GGUF_RUNTIME_CHANGED')
    const configured:VoxGgufConnection={python:connection.python,model,gguf:{runtimeDir:connection.runtimeDir,derivativeDir:trained?trainedConnection!.gguf.derivativeDir:model,receipt:connection.receipt},...fields}
    if(trained){this.voxGgufConfig=configured;this.voxTrainedGgufBackends[connection.id==='vox-vulkan'?'vulkan':'cuda']=configured}
    else this.voxPublicGgufBackends[connection.id==='vox-vulkan'?'vulkan':'cuda']=configured
   }
   this.runtime=null;this.verifiedBase=null;this.state.error=null;this.state.status=this.state.enabled?'unavailable':'off'
   this.state.ggufRuntimeSetup!.application='connected'
  },true)
 }
 prepareVoiceFiles(current=()=>true):Promise<void>{
  if(this.filePreparationTask)return this.filePreparationTask
  this.assertModelsAvailable()
  const id=this.selectedGgufRuntimeId(),runtime=this.ggufRuntimeInstaller?.snapshot().find(value=>value.id===id)
  if(!id||!runtime?.supported||!runtime.available)throw Error('GGUF_RUNTIME_ARTIFACT_PENDING')
  this.assertRuntimeTerms()
  const modelId:GgufModelId=id.startsWith('qwen')?'qwen3-tts-06b-gguf':'voxcpm2-gguf-f16'
  const trained=id.startsWith('vox')&&!isManagedVoice(this.selectedProfile())
  if(trained&&!this.voxGgufConnection())throw Error('VOX_GGUF_DERIVATIVE_UNSUPPORTED')
  const epoch=this.filePreparationEpoch,settings=this.qwenSettingsEpoch,engine=this.state.engine,profile=this.activeProfile(),voice=this.selectedProfile()?.fingerprint
  const valid=()=>!this.disposed&&epoch===this.filePreparationEpoch&&settings===this.qwenSettingsEpoch&&current()&&engine===this.state.engine&&profile===this.activeProfile()&&voice===this.selectedProfile()?.fingerprint
  const task:Promise<void>=Promise.resolve().then(async()=>{
   if(!valid())return
   this.state.filePreparation={busy:true,id,phase:'models',error:null};this.emit()
   if(!trained)await this.installGgufModel(modelId,valid)
   if(!valid())return
   this.state.filePreparation={busy:true,id,phase:'runtime',error:null};this.emit()
   await this.setupGgufRuntime(id,'install',valid)
   if(!valid())return
   if(this.state.gpuBackend==='auto'){
    const other=(id.endsWith('cuda')?id.replace('cuda','vulkan'):id.replace('vulkan','cuda')) as GgufRuntimeId
    if(this.ggufRuntimeInstaller?.snapshot().some(value=>value.id===other&&value.available)){
     this.state.filePreparation={busy:true,id:other,phase:'runtime',error:null};this.emit()
     await this.setupGgufRuntime(other,'install',valid)
    }
   }
   if(!valid())return
   this.state.filePreparation={busy:true,id,phase:this.state.ggufRuntimeSetup?.application==='connected'?'connected':'deferred',error:null}
  }).catch(error=>{
   if(!valid())return
   const code=error instanceof Error&&/^[A-Z_]{1,80}$/.test(error.message)?error.message:'GGUF_RUNTIME_INSTALL_FAILED'
   this.state.filePreparation={busy:true,id,phase:'error',error:code};throw Error(code)
  }).finally(()=>{if(this.filePreparationTask===task){this.filePreparationTask=null;if(this.state.filePreparation){this.state.filePreparation.busy=false;if(!valid()&&this.state.filePreparation.phase!=='error')this.state.filePreparation.phase=epoch!==this.filePreparationEpoch?'cancelled':'deferred';this.state.filePreparation.cancelling=false}this.emit()}})
  this.filePreparationTask=task;return task
 }
 async cancelPrepareVoiceFiles(){
  const task=this.filePreparationTask;if(!task)return
  ++this.filePreparationEpoch
  if(this.state.filePreparation){this.state.filePreparation.cancelling=true;this.emit()}
  await Promise.all([this.cancelInstallGgufModel(),this.cancelInstallGgufRuntime()]);await task.catch(()=>{})
 }
 setupGgufRuntime(id:GgufRuntimeId,mode:'install'|'repair'|'verify',current=()=>true):Promise<void>{
  if(this.managedTask)return Promise.reject(Error('VOICE_MODEL_REMOVAL_BUSY'))
  if(this.runtimeCancelTask)return Promise.reject(Error('GGUF_RUNTIME_BUSY'))
  if(this.runtimeSetupTask)return this.runtimeSetupId===id?this.runtimeSetupTask:Promise.reject(Error('GGUF_RUNTIME_BUSY'))
  if(!this.ggufRuntimeInstaller||!this.qwenGgufSupported())return Promise.reject(Error('GGUF_RUNTIME_ARTIFACT_PENDING'))
  if(this.selectedGgufRuntimeId()!==id&&!(this.state.gpuBackend==='auto'&&id.split('-')[0]===this.selectedGgufRuntimeId()?.split('-')[0]))return Promise.reject(Error('VOICE_ACTION'))
  const epoch=this.runtimeSetupEpoch,engine=this.state.engine,execution=this.activeProfile(),fingerprint=this.selectedProfile()?.fingerprint
  let operation:number|undefined
  const valid=()=>!this.disposed&&epoch===this.runtimeSetupEpoch&&current()&&this.state.engine===engine&&this.activeProfile()===execution&&this.selectedProfile()?.fingerprint===fingerprint&&(operation===undefined||operation===this.operation)
  const task:Promise<void>=Promise.resolve().then(async()=>{
   this.state.ggufRuntimeSetup={busy:true,id,error:null};this.emit()
   this.assertRuntimeTerms()
   await Promise.all([this.cancelInstallBase(),this.cancelInstallQwen(),this.cancelInstallGgufModel(),this.cancelModelCheck()])
   await this.stop();operation=this.operation
   if(!valid()){if(epoch===this.runtimeSetupEpoch)this.state.ggufRuntimeSetup!.application='deferred';return}
   const connection=await this.ggufRuntimeInstaller![mode](id)
   if(!connection||!valid()){if(epoch===this.runtimeSetupEpoch)this.state.ggufRuntimeSetup!.application='deferred';return}
   await this.applyGgufRuntime(connection,valid)
  }).catch(error=>{
   if(epoch!==this.runtimeSetupEpoch||this.disposed)return
   const code=error instanceof Error&&/^(?:GGUF_RUNTIME|GGUF_MODEL|VOICE_MODEL|VOICE_DOWNLOAD|CHAT_SETTINGS)_[A-Z_]+$/.test(error.message)?error.message:'GGUF_RUNTIME_INSTALL_FAILED'
   this.state.ggufRuntimeSetup={busy:true,id,error:code};throw Error(code)
  }).finally(()=>{if(this.runtimeSetupTask===task){this.runtimeSetupTask=null;this.runtimeSetupId=null;if(this.state.ggufRuntimeSetup)this.state.ggufRuntimeSetup.busy=false;this.emit()}})
  this.runtimeSetupTask=task;this.runtimeSetupId=id;return task
 }
 cancelInstallGgufRuntime():Promise<void>{
  if(this.runtimeCancelTask)return this.runtimeCancelTask
  if(!this.ggufRuntimeInstaller&&!this.runtimeSetupTask)return Promise.resolve()
  ++this.runtimeSetupEpoch
  const preparing=this.preparing,checking=this.modelCheckTask
  // Internal admission verification belongs to prepare/read/model-check rather
  // than setup. Revoke its context before aborting the shared verifier, then
  // drain both owners; cancellation must not mark model files as damaged.
  const stopping=!this.runtimeSetupTask&&(preparing||checking||this.currentSpeech)?this.stop():Promise.resolve()
  void stopping.catch(()=>{})
  if(!this.state.ggufRuntimeSetup)this.state.ggufRuntimeSetup={busy:false,id:this.selectedGgufRuntimeId(),error:null}
  if(this.state.ggufRuntimeSetup)this.state.ggufRuntimeSetup.cancelling=true
  this.emit()
  const task:Promise<void>=Promise.resolve().then(async()=>{try{await this.ggufRuntimeInstaller?.cancel()}finally{await Promise.all([stopping,preparing?.catch(()=>{}),checking?.catch(()=>{}),this.runtimeSetupTask?.catch(()=>{})])}}).finally(()=>{if(this.runtimeCancelTask===task){this.runtimeCancelTask=null;if(this.state.ggufRuntimeSetup)this.state.ggufRuntimeSetup.cancelling=false;this.emit()}})
  this.runtimeCancelTask=task;return task
 }
 private managedFields(value:any):ManagedRuntimeFields{
  if(!value?.managedRuntime)return {}
  const m=value.managedRuntime
  if(typeof m.root!=='string'||typeof m.receipt!=='string'||!['qwen-cuda','qwen-vulkan','vox-cuda','vox-vulkan'].includes(m.runtimeId)||!Array.isArray(value.dependencyDirs)||value.dependencyDirs.some((p:unknown)=>typeof p!=='string'))throw Error('VOICE_SETTINGS')
  return {managedRuntime:{root:m.root,receipt:m.receipt,runtimeId:m.runtimeId},dependencyDirs:[...value.dependencyDirs]}
 }
 private savedVoxConnection(value:any):VoxGgufConnection|null{if(!value||!['python','model'].every(k=>typeof value[k]==='string')||!value.gguf||!['runtimeDir','derivativeDir','receipt'].every(k=>typeof value.gguf[k]==='string'))return null;return {python:value.python,model:value.model,gguf:{runtimeDir:value.gguf.runtimeDir,derivativeDir:value.gguf.derivativeDir,receipt:value.gguf.receipt},...this.managedFields(value)}}
 snapshot(){
  this.syncReplayScope()
  const s=structuredClone(this.state),selected=this.selectedProfile(),managed=isManagedVoice(selected)
  s.platform=process.platform;s.arch=process.arch;s.engineReady=!!this.runtime?.ready
  if(process.platform==='win32'){s.modelVerification=this.modelVerification;s.ggufCatalog=GGUF_MODEL_CATALOG;s.ggufInstall=this.ggufInstaller?.snapshot();s.ggufRuntimeInstall=this.ggufRuntimeInstaller?.snapshot();s.ggufRuntimeCatalog=this.ggufRuntimeCatalog?{schemaVersion:1,platform:this.ggufRuntimeCatalog.platform,runtimes:Object.values(this.ggufRuntimeCatalog.runtimes).map(({id,engine,backend,title,support,pythonVersion})=>({id,engine,backend,title,support,pythonVersion}))}:undefined}
  s.availableEngines=this.qwenSupported()?['voxcpm2','qwen3-tts-06b',...(this.qwenGgufSupported()?['qwen3-tts-06b-gguf' as const]:[])]:['voxcpm2'];s.qwenConfigured=!!this.qwenConfig;s.qwenGgufConfigured=!!this.qwenConnection()&&this.state.engine==='qwen3-tts-06b-gguf';s.voxGgufConfigured=!!this.voxGgufConnection()
  if(this.qwenInstaller){s.qwenInstall=this.qwenInstaller.snapshot();s.qwenInstall.applied=s.engine==='qwen3-tts-06b'&&!!this.qwenConfig;s.qwenInstall.applicationDeferred=this.qwenApplicationDeferred}
  s.engineCapabilities={synthesisStreaming:isStreamingProfile(this.activeProfile()),cancellation:s.engine==='qwen3-tts-06b'?'owned-process-termination':'cooperative-with-process-fallback'}
  s.results=this.replay.infos()
  s.resolvedGpuBackend=voiceProfileBackend(this.activeProfile());s.gpuBackend=this.state.gpuBackend==='auto'?'auto':s.resolvedGpuBackend??this.state.gpuBackend;s.gpuFallback=this.state.gpuBackend==='auto'&&this.automaticBackend==='vulkan';
  s.executionProfile=this.activeProfile();s.runtimeConfigured=!!this.configured();s.referenceImport={busy:!!this.referenceOperation,error:this.referenceImportError}
  const termsRuntime=this.selectedGgufRuntimeId();if(termsRuntime&&this.ggufRuntimeTerms)s.ggufRuntimeTerms=this.ggufRuntimeTerms.snapshot(termsRuntime)
  if(this.base){s.baseInstall=this.base.snapshot();if(s.baseInstall.supported){s.defaultProfile=this.baseKey();if(!this.base.native)s.availableProfiles=managed?['cuda-compiled','cuda-compiled-complete',...(this.qwenGgufSupported()?['gguf-cuda-f16','gguf-cuda-f16-complete','gguf-vulkan-f16','gguf-vulkan-f16-complete'] as ExecutionProfile[]:[])]:['baseline','cached','compiled',...(this.qwenGgufSupported()?['gguf-cuda-f16','gguf-cuda-f16-complete','gguf-vulkan-f16','gguf-vulkan-f16-complete'] as ExecutionProfile[]:[])]}}
  if(isQwenEngine(this.state.engine)){const gguf=this.state.engine==='qwen3-tts-06b-gguf';s.availableProfiles=gguf?['qwen-gguf','qwen-gguf-complete','qwen-gguf-vulkan','qwen-gguf-vulkan-complete']:process.platform==='darwin'?['qwen-mlx','qwen-mlx-complete']:['qwen-complete'];s.defaultProfile=undefined;if(gguf)s.modelVerification='full';if(this.state.enabled&&(!isReferenceProfile(selected)||selected.error||!this.qwenConnection())){s.status='unavailable';s.error=!isReferenceProfile(selected)?'QWEN_REFERENCE_REQUIRED':selected.error|| (gguf?'QWEN_GGUF_RUNTIME_MISSING':'QWEN_RUNTIME_MISSING')}}
  if(!isQwenEngine(this.state.engine)&&isWindowsVoxGgufProfile(this.activeProfile())){s.modelVerification='full';if(!managed)s.defaultProfile=undefined;if(this.state.enabled&&!s.runtimeConfigured){s.status='unavailable';s.error=!selected?'VOICE_REFERENCE_UNAVAILABLE':'VOX_GGUF_RUNTIME_MISSING'}}
  if(!isQwenEngine(this.state.engine)&&!isWindowsVoxGgufProfile(this.activeProfile())&&this.state.enabled&&((managed&&!s.runtimeConfigured)||isReferenceProfile(selected)&&selected.error||referenceKey(this.bindingKey(this.chat().character?.id||''))&&!selected)){
   s.status='unavailable';s.error=isReferenceProfile(selected)&&selected.error?selected.error:!selected?'VOICE_REFERENCE_UNAVAILABLE':s.error||'VOICE_BASE_NOT_INSTALLED'
  }
  if(s.seedError){s.status='error';s.error='VOICE_SEED_SETTINGS'}
  if(this.state.enabled){try{this.assertConfiguredRuntimeTerms()}catch(error){s.status='unavailable';s.engineReady=false;s.error=(error as Error).message}}
  return s
 }
 private baseKey(){return this.base?profileKey(this.base.profile):BASE_KEY}
 private activeProfile():ExecutionProfile{
  const profile=this.state.engine==='qwen3-tts-06b-gguf'?this.qwenGgufExecutionProfile:this.state.engine==='qwen3-tts-06b'?process.platform==='darwin'?this.qwenExecutionProfile:'qwen-complete':isManagedVoice(this.selectedProfile())&&this.base&&!this.base.native?this.baseExecutionProfile:this.state.executionProfile||'baseline'
  return voiceProfileBackend(profile)&&this.state.gpuBackend==='auto'?voiceBackendProfile(profile,this.automaticBackend):profile
 }
 private bindingKey(id:string){return this.state.bindings[id]??(this.base?.snapshot().supported?this.baseKey():'')}
 refreshBase(){this.emit()}
 installQwen(current=()=>true):Promise<void>{
  this.assertModelsAvailable()
  if(this.installingQwen)return this.installingQwen
  if(!this.qwenInstaller||!this.qwenSupported())return Promise.reject(Error('QWEN_INSTALL_UNSUPPORTED'))
  const epoch=this.qwenInstallEpoch,settings=this.qwenSettingsEpoch
  const valid=()=>!this.disposed&&epoch===this.qwenInstallEpoch&&settings===this.qwenSettingsEpoch&&current()
  this.qwenApplicationDeferred=false
  const task:Promise<void>=Promise.resolve().then(async()=>{
   if(!valid())return
   const connection=await this.qwenInstaller!.install(this.qwenConfig?.model)
   if(!connection)return
   if(!valid()){this.qwenApplicationDeferred=true;this.emit();return}
   this.qwenInstaller!.applying(true)
   await this.mutate(async()=>{
    if(!valid()){this.qwenApplicationDeferred=true;return}
    await this.stop()
    if(!valid()){this.qwenApplicationDeferred=true;return}
    this.qwenConfig=connection;this.state.engine='qwen3-tts-06b';this.runtime=null;this.state.error=null
    // Preserve compatible user-selected WAV bindings. Missing reference is
    // truthful setup-needed state; never select another speaker or synthesize.
    this.state.status=this.state.enabled?'idle':'off'
   })
  }).finally(()=>{if(this.installingQwen===task){this.qwenInstaller?.applying(false);this.installingQwen=null}})
  this.installingQwen=task;return task
 }
 async cancelInstallQwen(){++this.qwenInstallEpoch;await this.qwenInstaller?.cancel();await this.installingQwen?.catch(()=>{})}
 installBase():Promise<void>{
  this.assertModelsAvailable()
  if(this.disposed)return Promise.resolve()
  if(this.installingBase)return this.installingBase
  if(!this.base)return Promise.reject(Error('VOICE_BASE_UNSUPPORTED'))
  const epoch=this.installEpoch
  const task:Promise<void>=Promise.resolve().then(async()=>{
   if(this.disposed||epoch!==this.installEpoch)return
   await this.base!.install()
   if(this.disposed||epoch!==this.installEpoch||!this.base!.snapshot().installed)return
   const repaired=this.blockedModels.delete(this.base!.path.toLowerCase());if(repaired&&!isQwenEngine(this.state.engine)&&isManagedVoice(this.selectedProfile()))this.state.modelCheck={busy:false,error:null};this.state.error=null;this.emit();await this.prepare()
  }).finally(()=>{if(this.installingBase===task)this.installingBase=null})
  this.installingBase=task;return task
 }
 async cancelInstallBase(){++this.installEpoch;const pending=this.installingBase;try{await this.base?.cancel()}finally{await pending?.catch(()=>{})}}
 private selectedProfile(){return this.state.profiles.find(p=>profileKey(p)===this.bindingKey(this.chat().character?.id||''))}
 private configured(){const p=this.selectedProfile();if(isQwenEngine(this.state.engine))return !!this.qwenConnection()&&isReferenceProfile(p)&&!p.error;if(isWindowsVoxGgufProfile(this.activeProfile()))return this.qwenGgufSupported()&&!!this.voxGgufConnection()&&!!p&&(!isReferenceProfile(p)||!p.error);return isReferenceProfile(p)&&p.error?false:isManagedVoice(p)?this.base?.snapshot().installed:!!this.config}
 private bestEffort(work:()=>void){try{work()}catch{console.warn('[voice] VOICE_NOTIFICATION_FAILED')}}
 private emit(){this.bestEffort(()=>this.changed(this.snapshot()))}
 private notify(event:VoiceEvent){this.bestEffort(()=>this.event(event))}
 private diagnose(value:Record<string,unknown>){this.bestEffort(()=>this.diagnostic(value))}
 get presentationVoiceMuted(){return this.presentationMuted}
 async setPresentationMuted(value:boolean){
  this.presentationMuted=value
  if(!value)return // Unmuting is lazy; only a new presentation may load again.
  const ownership=this.runtimeOwners?.runtime===this.runtime&&this.runtimeOwners.session===this.runtime?.sessionId?this.runtimeOwners:null
  const localDemand=ownership?.owners.has('local')||this.outputReady&&this.outputOwner==='local'||!!this.preparing||!!this.currentSpeech&&this.speechOwner==='local'
  const presentationActive=this.outputReady&&this.outputOwner==='presentation'||!!this.currentSpeech&&this.speechOwner==='presentation'
  ownership?.owners.delete('presentation')
  if(presentationActive){this.outputReady=false;await this.stop(true,!localDemand,!localDemand)}
  else if(ownership?.runtime===this.runtime&&!localDemand)await this.stop()
 }
 setOutputReady(ready:boolean,prepareOnReady=true,owner:VoiceOutputOwner='local'){
  this.outputOwner=owner
  if(this.outputReady===(ready&&!this.disposed))return
  this.outputReady=ready&&!this.disposed
  if(!this.outputReady){this.allowedRequests.clear();void this.stop(true,false,true).catch(e=>this.error(e))}
  else if(prepareOnReady)void this.prepare()
 }

 async initialize(){
  try {
   await mkdir(join(this.root,'profiles'),{recursive:true})
   // Previous process owns no active cache after an app restart.
   await rm(join(this.root,'cache'),{recursive:true,force:true,maxRetries:2}).catch(()=>{})
   try{const saved=JSON.parse(await readFile(join(this.root,'settings.json'),'utf8'))
    if(saved.version!==1||typeof saved.enabled!=='boolean'||typeof saved.autoRead!=='boolean'||!Number.isFinite(saved.volume)||saved.volume<0||saved.volume>1||!saved.bindings||typeof saved.bindings!=='object'||Array.isArray(saved.bindings))throw Error('VOICE_SETTINGS')
    this.pendingRemoval=new Set(Array.isArray(saved.pendingRemoval)?saved.pendingRemoval.filter((v:unknown)=>typeof v==='string'&&/^[a-z0-9_-]+@[a-zA-Z0-9._-]+$/.test(v)):[])
    if(Object.hasOwn(saved,'seedSettings')){if(validSeedSettings(saved.seedSettings))this.state.seedSettings={...saved.seedSettings};else{this.state.seedError=true;this.state.error='VOICE_SEED_SETTINGS'}}
    this.state.engine='voxcpm2' // Existing settings without an engine keep their original Vox path.
    if(saved.engine==='qwen3-tts-06b'&&this.qwenSupported()||saved.engine==='qwen3-tts-06b-gguf'&&this.qwenGgufSupported())this.state.engine=saved.engine
    if(saved.qwenRuntime&&typeof saved.qwenRuntime.python==='string'&&typeof saved.qwenRuntime.model==='string')this.qwenConfig=saved.qwenRuntime
    if(saved.qwenGgufRuntime&&['python','model','ggufRuntime'].every(k=>typeof saved.qwenGgufRuntime[k]==='string'))this.qwenGgufConfig={python:saved.qwenGgufRuntime.python,model:saved.qwenGgufRuntime.model,ggufRuntime:saved.qwenGgufRuntime.ggufRuntime,...this.managedFields(saved.qwenGgufRuntime),...(typeof saved.qwenGgufRuntime.ggufVulkanRuntime==='string'?{ggufVulkanRuntime:saved.qwenGgufRuntime.ggufVulkanRuntime,ggufVulkanManagedRuntime:this.managedFields({managedRuntime:saved.qwenGgufRuntime.ggufVulkanManagedRuntime,dependencyDirs:saved.qwenGgufRuntime.ggufVulkanDependencyDirs}).managedRuntime,ggufVulkanDependencyDirs:this.managedFields({managedRuntime:saved.qwenGgufRuntime.ggufVulkanManagedRuntime,dependencyDirs:saved.qwenGgufRuntime.ggufVulkanDependencyDirs}).dependencyDirs}:{})}
    for(const backend of ['cuda','vulkan'] as const){const value=saved.qwenGgufBackends?.[backend];if(value&&['python','model','ggufRuntime'].every(k=>typeof value[k]==='string'))this.qwenGgufBackends[backend]={python:value.python,model:value.model,ggufRuntime:value.ggufRuntime,...this.managedFields(value)}}
    this.voxGgufConfig=this.savedVoxConnection(saved.voxGgufRuntime)
    for(const backend of ['cuda','vulkan'] as const){const value=this.savedVoxConnection(saved.voxTrainedGgufBackends?.[backend]);if(value)this.voxTrainedGgufBackends[backend]=value}
    const publicConnection=this.savedVoxConnection(saved.voxPublicGgufRuntime)
    if(publicConnection&&publicConnection.model===publicConnection.gguf.derivativeDir)this.voxPublicGgufConfig=publicConnection
    for(const backend of ['cuda','vulkan'] as const){const value=this.savedVoxConnection(saved.voxPublicGgufBackends?.[backend]);if(value&&value.model===value.gguf.derivativeDir)this.voxPublicGgufBackends[backend]=value}
    if(['qwen-gguf','qwen-gguf-complete','qwen-gguf-vulkan','qwen-gguf-vulkan-complete'].includes(saved.qwenGgufExecutionProfile))this.qwenGgufExecutionProfile=saved.qwenGgufExecutionProfile
    if(saved.qwenExecutionProfile==='qwen-mlx-complete')this.qwenExecutionProfile=saved.qwenExecutionProfile
    if(saved.qwenClone){if(!this.validQwenClone(saved.qwenClone))throw Error('VOICE_SETTINGS');this.state.qwenClone=saved.qwenClone}
    if(process.platform==='win32'&&saved.modelVerification==='installed')this.modelVerification='installed'
    this.state.enabled=saved.enabled;this.state.autoRead=saved.autoRead;this.state.volume=saved.volume
    const supported=this.state.availableProfiles||[], selected=saved.executionProfile||'baseline'
    if(supported.includes(selected))this.state.executionProfile=selected
    else {this.state.executionProfile=supported[0];this.state.enabled=false;this.state.error='VOICE_PLATFORM_PROFILE'}
    this.baseExecutionProfile=['cuda-compiled','cuda-compiled-complete','gguf-cuda-f16','gguf-cuda-f16-complete','gguf-vulkan-f16','gguf-vulkan-f16-complete'].includes(saved.baseExecutionProfile)?saved.baseExecutionProfile:saved.executionProfile==='cuda-compiled-complete'?'cuda-compiled-complete':'cuda-compiled'
    const savedVoiceKey=saved.bindings[this.chat().character?.id||'']??this.baseKey()
    const savedManaged=!!this.base&&!this.base.native&&(savedVoiceKey===this.baseKey()||!!referenceKey(savedVoiceKey))
    this.state.gpuBackend=isGpuBackendPreference(saved.gpuBackend)?saved.gpuBackend:voiceProfileBackend(this.state.engine==='qwen3-tts-06b-gguf'?this.qwenGgufExecutionProfile:savedManaged?this.baseExecutionProfile:this.state.executionProfile)??'auto'
    // Migrate only the new managed-mode names; preserve every legacy external mode.
    if(this.state.executionProfile?.startsWith('cuda-compiled'))this.state.executionProfile='compiled'
    this.state.bindings=Object.fromEntries(Object.entries(saved.bindings).filter(([k,v])=>k.length<=80&&typeof v==='string'&&v.length<=170)) as Record<string,string>
    if(saved.runtime&&typeof saved.runtime.python==='string'&&typeof saved.runtime.model==='string'){this.config=saved.runtime;this.state.runtimeConfigured=true}
   }catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw Error('VOICE_SETTINGS')}
   if(this.qwenGgufSupported()&&this.state.gpuBackend==='auto'&&this.detectGpu)this.automaticBackend=await this.detectGpu().catch(()=>this.automaticBackend)
   await this.references.initialize().catch(()=>{this.referenceImportError='VOICE_REFERENCE_STORAGE'})
   for(const key of this.pendingRemoval)await this.removeFiles(key).catch(()=>{this.state.error='VOICE_CLEANUP_PENDING'})
   for(const entry of await readdir(join(this.root,'profiles'),{withFileTypes:true}))if(entry.isDirectory()&&!entry.name.startsWith('.')){
    if(this.pendingRemoval.has(entry.name)){await this.removeFiles(entry.name).catch(()=>{this.state.error='VOICE_CLEANUP_PENDING'});continue}
    const p=await verifyVoicePackage(join(this.root,'profiles',entry.name),process.platform==='darwin'?undefined:SELECTED_VOICE)
    if(entry.name!==profileKey(p.profile))throw Error('VOICE_PROFILE_PATH')
    this.state.profiles.push(p.profile)
   }
   this.state.profiles.push(...this.references.list().filter(p=>!this.pendingRemoval.has(profileKey(p))))
   await this.qwenInstaller?.initialize()
   await this.ggufInstaller?.initialize()
   await this.ggufRuntimeInstaller?.initialize()
   await this.ggufRuntimeTerms?.initialize()
   if(this.base){await this.base.initialize();if(this.base.snapshot().supported)this.state.profiles.push(this.base.profile)}
   for(const [character,key] of Object.entries(this.state.bindings))if(!referenceKey(key)&&!this.state.profiles.some(p=>profileKey(p)===key))delete this.state.bindings[character]
   this.state.status=this.state.enabled?'idle':'off';this.emit()
  }catch{this.error(Error('VOICE_STORAGE'))}
 }
 private async save(){
  await mkdir(this.root,{recursive:true});const temp=join(this.root,'settings-'+randomUUID()+'.tmp')
  try{await writeFile(temp,JSON.stringify({version:1,gpuBackend:this.state.gpuBackend==='auto'?'auto':voiceProfileBackend(this.activeProfile())??this.state.gpuBackend,...(process.platform==='win32'?{modelVerification:this.modelVerification}:{}),engine:this.state.engine,qwenRuntime:this.qwenConfig,qwenGgufRuntime:this.qwenGgufConfig,qwenGgufBackends:this.qwenGgufBackends,voxGgufRuntime:this.voxGgufConfig,voxTrainedGgufBackends:this.voxTrainedGgufBackends,voxPublicGgufRuntime:this.voxPublicGgufConfig,voxPublicGgufBackends:this.voxPublicGgufBackends,qwenGgufExecutionProfile:this.qwenGgufExecutionProfile,qwenExecutionProfile:this.qwenExecutionProfile,qwenClone:this.state.qwenClone,enabled:this.state.enabled,autoRead:this.state.autoRead,volume:this.state.volume,bindings:this.state.bindings,runtime:this.config,pendingRemoval:[...this.pendingRemoval],executionProfile:this.state.executionProfile||'baseline',baseExecutionProfile:this.baseExecutionProfile,seedSettings:this.state.seedError?{invalid:true}:this.state.seedSettings})+'\n',{flag:'wx'});await replaceFile(temp,join(this.root,'settings.json'))}
  finally{await rm(temp,{force:true}).catch(()=>{})}
 }
 private mutate(work:()=>Promise<void>,runtimeOwner=false){this.assertModelsAvailable(runtimeOwner);const task=this.serial.then(async()=>{if(this.disposed)return;const previous=structuredClone(this.state),config=this.config,qwenConfig=this.qwenConfig,ggufConfig=this.qwenGgufConfig,qwenGgufBackends={...this.qwenGgufBackends},voxGgufConfig=this.voxGgufConfig,voxTrainedGgufBackends={...this.voxTrainedGgufBackends},voxPublicGgufConfig=this.voxPublicGgufConfig,voxPublicGgufBackends={...this.voxPublicGgufBackends},ggufMode=this.qwenGgufExecutionProfile,qwenMode=this.qwenExecutionProfile,baseMode=this.baseExecutionProfile,modelVerification=this.modelVerification,automaticBackend=this.automaticBackend,removals=new Set(this.pendingRemoval);try{await work();await this.save();this.emit()}catch(e){this.state={...previous,epoch:this.state.epoch};this.config=config;this.qwenConfig=qwenConfig;this.qwenGgufConfig=ggufConfig;this.qwenGgufBackends=qwenGgufBackends;this.voxGgufConfig=voxGgufConfig;this.voxTrainedGgufBackends=voxTrainedGgufBackends;this.voxPublicGgufConfig=voxPublicGgufConfig;this.voxPublicGgufBackends=voxPublicGgufBackends;this.qwenGgufExecutionProfile=ggufMode;this.qwenExecutionProfile=qwenMode;this.baseExecutionProfile=baseMode;this.modelVerification=modelVerification;this.automaticBackend=automaticBackend;this.pendingRemoval=removals;this.error(e)}});this.serial=task.catch(()=>{});return task}
 error(e:unknown){this.state.error=e instanceof Error&&/^[A-Z_]{1,80}$/.test(e.message)?e.message:'VOICE_ERROR';this.state.status='error';this.emit()}
 async importPackage(path:string){return this.mutate(async()=>{const p=await importVoicePackage(path,join(this.root,'profiles'),process.platform==='darwin'?undefined:SELECTED_VOICE);if(!this.state.profiles.some(v=>profileKey(v)===profileKey(p.profile)))this.state.profiles.push(p.profile);this.pendingRemoval.delete(profileKey(p.profile));this.state.error=null})}
 importReference(path:string,name:string,current=()=>true):Promise<void>{
  if(this.disposed)return Promise.resolve()
  if(this.referenceOperation)return this.referenceOperation.task
  const controller=new AbortController(),operation={controller,task:Promise.resolve()}
  this.referenceImportError=null;this.referenceOperation=operation
  operation.task=Promise.resolve().then(async()=>{
   const poll=setInterval(()=>{if(!current()||this.disposed)controller.abort()},50)
   try{const p=await this.references.import(path,name,controller.signal,()=>!this.disposed&&current());const publish=this.serial.then(()=>{this.state.profiles.push(p)});this.serial=publish.catch(()=>{});await publish}
   catch(e){if(!controller.signal.aborted&&!this.disposed&&!(e instanceof Error&&e.message==='VOICE_REFERENCE_CANCELLED'))this.referenceImportError=e instanceof Error&&/^VOICE_REFERENCE_[A-Z_]+$/.test(e.message)?e.message:'VOICE_REFERENCE_IMPORT'}
   finally{clearInterval(poll);if(this.referenceOperation===operation)this.referenceOperation=null;this.emit()}
  });this.emit();return operation.task
 }
 async cancelReferenceImport(){const operation=this.referenceOperation;if(operation){operation.controller.abort();await operation.task}}
 renameReference(profile:string,name:string,current=()=>true){const task=this.serial.then(async()=>{if(this.disposed||!current())throw Error('CHAT_SETTINGS_EXPIRED');await this.references.rename(profile,name,()=>!this.disposed&&current());const p=this.references.list().find(p=>profileKey(p)===profile);if(p)this.state.profiles=this.state.profiles.map(old=>profileKey(old)===profile?p:old);this.emit()});this.serial=task.catch(()=>{});return task}
 private validQwenClone(value:unknown):value is import('../../shared/character-voice-contract').QwenCloneSettings{const v=value as any;return !!v&&['x-vector','icl'].includes(v.mode)&&typeof v.transcript==='string'&&v.transcript.length<=2000&&!/[\x00-\x08\x0b-\x1f\x7f]/.test(v.transcript)&&(v.mode!=='icl'||!!v.transcript.trim())}
 private removalContains(plan:ManagedVoiceModelRemoval,path:string|undefined){return !!path&&plan.directories.some(directory=>{const rel=relative(directory.path,path);return !rel||rel!=='..'&&!rel.startsWith('../')&&!rel.startsWith('..\\')&&!isAbsolute(rel)})}
 modelRemovalImpact(plan:ManagedVoiceModelRemoval){
  if(isQwenEngine(this.state.engine))return this.removalContains(plan,this.qwenConnection()?.model)
  if(isWindowsVoxGgufProfile(this.activeProfile())){const vox=this.voxGgufConnection();return this.removalContains(plan,vox?.model)||this.removalContains(plan,vox?.gguf.derivativeDir)}
  return this.removalContains(plan,isManagedVoice(this.selectedProfile())?this.base?.path:this.config?.model)
 }
 private disconnectRemovedModels(plan:ManagedVoiceModelRemoval){
  const removed=(value:{model:string}|null|undefined)=>!!value&&this.removalContains(plan,value.model)
  if(removed(this.config)){this.config=null;this.state.runtimeConfigured=false}
  if(removed(this.qwenConfig))this.qwenConfig=null
  if(removed(this.qwenGgufConfig))this.qwenGgufConfig=null
  for(const backend of ['cuda','vulkan'] as const){
   if(removed(this.qwenGgufBackends[backend]))delete this.qwenGgufBackends[backend]
   if(removed(this.voxTrainedGgufBackends[backend])||this.removalContains(plan,this.voxTrainedGgufBackends[backend]?.gguf.derivativeDir))delete this.voxTrainedGgufBackends[backend]
   if(removed(this.voxPublicGgufBackends[backend]))delete this.voxPublicGgufBackends[backend]
  }
  if(removed(this.voxGgufConfig)||this.removalContains(plan,this.voxGgufConfig?.gguf.derivativeDir))this.voxGgufConfig=null
  if(removed(this.voxPublicGgufConfig))this.voxPublicGgufConfig=null
 }
 modelRemovalContext(){return createHash('sha256').update(JSON.stringify({engine:this.state.engine,executionProfile:this.activeProfile(),bindings:this.state.bindings,config:this.config,qwen:this.qwenConfig,qwenGguf:this.qwenGgufConfig,qwenBackends:this.qwenGgufBackends,vox:this.voxGgufConfig,voxBackends:this.voxTrainedGgufBackends,voxPublic:this.voxPublicGgufConfig,voxPublicBackends:this.voxPublicGgufBackends})).digest('hex')}
 gpuBackend(value:GpuBackendPreference,current=()=>true){
  if(!this.qwenGgufSupported()||!isGpuBackendPreference(value)||!voiceProfileBackend(this.activeProfile()))throw Error('VOICE_ACTION')
  ++this.qwenSettingsEpoch;void this.stop().catch(()=>{})
  return this.mutate(async()=>{
   await this.stop();if(!current())throw Error('CHAT_SETTINGS_EXPIRED')
   const detected=value==='auto'&&this.detectGpu?await this.detectGpu():this.automaticBackend
   if(!current())throw Error('CHAT_SETTINGS_EXPIRED')
   if(value!=='auto'){
    const profile=voiceBackendProfile(this.activeProfile(),value)
    if(this.state.engine==='qwen3-tts-06b-gguf')this.qwenGgufExecutionProfile=profile
    else if(isManagedVoice(this.selectedProfile())&&this.base&&!this.base.native)this.baseExecutionProfile=profile
    else this.state.executionProfile=profile
   }
   this.state.gpuBackend=value;this.automaticBackend=detected
   this.runtime=null;this.verifiedBase=null;this.state.error=null
   this.state.status=this.state.enabled?'idle':'off'
  }).then(()=>this.prepare())
 }
 selectVoicePath(id:VoiceSetupPathId,current=()=>true){
  const path=voiceSetupPaths(process.platform,process.arch).find(path=>path.id===id)
  if(!path)throw Error('VOICE_ACTION')
  this.assertModelsAvailable()
  if(!current())throw Error('CHAT_SETTINGS_EXPIRED')
  if(currentVoiceSetupPath(this.snapshot())===id)return Promise.resolve()
  ++this.qwenSettingsEpoch;void this.stop().catch(()=>{})
  return this.mutate(async()=>{
   await this.stop();if(!current())throw Error('CHAT_SETTINGS_EXPIRED')
   this.state.engine=path.engine
   if(path.engine==='qwen3-tts-06b-gguf')this.qwenGgufExecutionProfile=path.profile
   else if(path.engine==='qwen3-tts-06b')this.qwenExecutionProfile=path.profile
   else {this.state.executionProfile=path.id==='vox-legacy'?'compiled':path.profile;this.baseExecutionProfile=path.profile}
   this.runtime=null;this.verifiedBase=null;this.state.error=null;this.state.status=this.state.enabled?'unavailable':'off'
  })
 }
 engine(value:import('../../shared/character-voice-contract').VoiceEngine,current=()=>true){++this.qwenSettingsEpoch;void this.stop().catch(()=>{});return this.mutate(async()=>{await this.stop();if(!current())throw Error('CHAT_SETTINGS_EXPIRED');if(!['voxcpm2','qwen3-tts-06b','qwen3-tts-06b-gguf'].includes(value)||value==='qwen3-tts-06b'&&!this.qwenSupported()||value==='qwen3-tts-06b-gguf'&&!this.qwenGgufSupported())throw Error('VOICE_ACTION');this.state.engine=value;this.runtime=null;this.state.error=null}).then(()=>this.prepare())}
 qwenClone(value:import('../../shared/character-voice-contract').QwenCloneSettings,current=()=>true){if(!this.validQwenClone(value))throw Error('QWEN_TRANSCRIPT_REQUIRED');void this.stop().catch(()=>{});return this.mutate(async()=>{await this.stop();if(!current())throw Error('CHAT_SETTINGS_EXPIRED');this.state.qwenClone={mode:value.mode,transcript:value.mode==='x-vector'?'':value.transcript};this.runtime=null;this.state.error=null})}
 configureQwen(python:string,model:string,current=()=>true){++this.qwenSettingsEpoch;void this.stop().catch(()=>{});return this.mutate(async()=>{await this.stop();if(!current())throw Error('CHAT_SETTINGS_EXPIRED');if(!this.qwenSupported())throw Error('VOICE_ACTION');this.qwenConfig={python,model};this.runtime=null;this.state.error=null})}
 configureQwenGguf(python:string,model:string,ggufRuntime:string,current=()=>true){++this.qwenSettingsEpoch;void this.stop().catch(()=>{});return this.mutate(async()=>{await this.stop();if(!current())throw Error('CHAT_SETTINGS_EXPIRED');if(!this.qwenGgufSupported())throw Error('QWEN_GGUF_UNSUPPORTED');const prior=this.qwenGgufConfig??{python,model,ggufRuntime:''};this.qwenGgufConfig=this.activeProfile().includes('-vulkan')?{...prior,python,model,ggufVulkanRuntime:ggufRuntime,ggufVulkanManagedRuntime:undefined,ggufVulkanDependencyDirs:undefined}:{...prior,python,model,ggufRuntime,managedRuntime:undefined,dependencyDirs:undefined};this.qwenGgufBackends[this.activeProfile().includes('-vulkan')?'vulkan':'cuda']={python,model,ggufRuntime};this.runtime=null;this.state.error=null})}
 configureVoxGguf(python:string,model:string,gguf:{runtimeDir:string;derivativeDir:string;receipt:string},current=()=>true){++this.qwenSettingsEpoch;void this.stop().catch(()=>{});return this.mutate(async()=>{await this.stop();if(!current())throw Error('CHAT_SETTINGS_EXPIRED');if(!this.qwenGgufSupported())throw Error('VOX_GGUF_PLATFORM');this.voxGgufConfig={python,model,gguf:{...gguf}};this.voxTrainedGgufBackends[this.activeProfile().includes('vulkan')?'vulkan':'cuda']=this.voxGgufConfig;this.runtime=null;this.state.error=null})}
 configureVoxPublicGguf(python:string,model:string,gguf:{runtimeDir:string;derivativeDir:string;receipt:string},current=()=>true){++this.qwenSettingsEpoch;void this.stop().catch(()=>{});return this.mutate(async()=>{await this.stop();if(!current())throw Error('CHAT_SETTINGS_EXPIRED');if(!this.qwenGgufSupported())throw Error('VOX_GGUF_PLATFORM');if(model!==gguf.derivativeDir)throw Error('VOX_GGUF_RUNTIME_CONFIG');this.voxPublicGgufConfig={python,model,gguf:{...gguf}};this.voxPublicGgufBackends[this.activeProfile().includes('vulkan')?'vulkan':'cuda']=this.voxPublicGgufConfig;this.runtime=null;this.state.error=null})}
 configure(python:string,model:string){++this.qwenSettingsEpoch;void this.stop().catch(()=>{});return this.mutate(async()=>{await this.stop();if(this.state.executionProfile?.startsWith('mps-')||this.state.executionProfile?.startsWith('gguf-metal-'))await verifyMacInterpreter(python,this.state.executionProfile);this.config={python,model};this.state.runtimeConfigured=true;this.runtime=null;this.state.error=null})}
 enabled(value:boolean){void this.stop().catch(()=>{});return this.mutate(async()=>{await this.stop();if(value&&!this.snapshot().availableProfiles?.length)throw Error('UNSUPPORTED_DEVICE');this.state.enabled=value;this.state.status=value?'idle':'off';this.state.error=null})}
 seedSettings(value:VoiceSeedSettings,current=()=>true){if(!validSeedSettings(value))throw Error('VOICE_SEED_INVALID');return this.mutate(async()=>{if(!current())throw Error('CHAT_SETTINGS_EXPIRED');this.state.seedSettings={...value};this.state.seedError=false;if(this.state.error==='VOICE_SEED_SETTINGS')this.state.error=null})}
 auto(value:boolean){return this.mutate(async()=>{this.state.autoRead=value})}
 volume(value:number){return this.mutate(async()=>{this.state.volume=value})}
 executionProfile(value:ExecutionProfile){void this.stop().catch(()=>{});return this.mutate(async()=>{await this.stop();const backend=voiceProfileBackend(value);if(backend)this.state.gpuBackend=backend;if(isWindowsVoxGgufProfile(value)&&!this.snapshot().availableProfiles?.includes(value))throw Error('VOICE_PLATFORM_PROFILE');if(this.state.engine==='qwen3-tts-06b-gguf'){if(!['qwen-gguf','qwen-gguf-complete','qwen-gguf-vulkan','qwen-gguf-vulkan-complete'].includes(value))throw Error('VOICE_PLATFORM_PROFILE');this.qwenGgufExecutionProfile=value;}else if(this.state.engine==='qwen3-tts-06b'){if(!(process.platform==='darwin'?['qwen-mlx','qwen-mlx-complete']:['qwen-complete']).includes(value))throw Error('VOICE_PLATFORM_PROFILE');this.qwenExecutionProfile=value;}else if(isManagedVoice(this.selectedProfile())&&this.base&&!this.base.native)this.baseExecutionProfile=value;else this.state.executionProfile=value;this.runtime=null;this.state.error=null}).then(()=>this.prepare())}
 modelVerificationPolicy(value:'full'|'installed',current=()=>true){if(process.platform!=='win32'||!['full','installed'].includes(value)||(this.state.engine==='qwen3-tts-06b-gguf'||isWindowsVoxGgufProfile(this.activeProfile()))&&value!=='full')throw Error('VOICE_ACTION');void this.stop().catch(()=>{});return this.mutate(async()=>{await this.stop();if(!current())throw Error('CHAT_SETTINGS_EXPIRED');this.modelVerification=value;this.runtime=null;this.verifiedBase=null}).then(()=>this.prepare())}
 checkModel(current=()=>true){
  this.assertModelsAvailable()
  if(process.platform!=='win32')throw Error('VOICE_ACTION')
  if(this.modelCheckTask)return this.modelCheckTask
  const controller=this.modelCheckController=new AbortController()
  const task=this.serial.then(async()=>{
   if(this.disposed||!current()||controller.signal.aborted)return
   await this.stop(true,true,true,true);if(!current()||controller.signal.aborted)return;const runtime=this.getRuntime(),started=Date.now()
   this.state.modelCheck={busy:true,error:null};this.emit()
   try{await checkWindowsModel(runtime.config.python,runtime.config.model,this.worker,this.state.engine||'voxcpm2',controller.signal,{managedRuntime:runtime.config.managedRuntime,beforeManagedSpawn:runtime.config.beforeManagedSpawn,...(isWindowsVoxGgufProfile(this.activeProfile())?{gguf:{...this.voxGgufConnection()!.gguf,package:isManagedVoice(this.selectedProfile())?'':join(this.root,'profiles',profileKey(this.selectedProfile()!)),executionProfile:this.activeProfile()},...(isManagedVoice(this.selectedProfile())?{ggufModelKind:'public-base' as const,...(isReferenceProfile(this.selectedProfile())?{conditioning:await this.references.resolve(profileKey(this.selectedProfile()!))}:{})}:{})}:{} )});if(!controller.signal.aborted&&!this.disposed){if(!isWindowsVoxGgufProfile(this.activeProfile()))this.blockedModels.delete(runtime.config.model.toLowerCase());if(!isQwenEngine(this.state.engine)&&!isWindowsVoxGgufProfile(this.activeProfile())&&isManagedVoice(this.selectedProfile()))this.base?.recordModelCheck?.(true);this.state.modelCheck={busy:false,error:null,completedAt:Date.now()};if(this.state.error==='VOICE_MODEL_CHECK_FAILED')this.state.error=null;}this.diagnose({type:'model-full-check',elapsedMs:Date.now()-started})}
   catch(e){if(!controller.signal.aborted&&!this.disposed){if(!isWindowsVoxGgufProfile(this.activeProfile()))this.blockedModels.add(runtime.config.model.toLowerCase());if(!isQwenEngine(this.state.engine)&&!isWindowsVoxGgufProfile(this.activeProfile())&&isManagedVoice(this.selectedProfile()))this.base?.recordModelCheck?.(false);this.state.modelCheck={busy:false,error:'VOICE_MODEL_CHECK_FAILED'};this.state.error='VOICE_MODEL_CHECK_FAILED';this.state.status='error'}}
   finally{if(this.modelCheckController===controller)this.modelCheckController=null;if(this.state.modelCheck)this.state.modelCheck.busy=false;this.emit()}
  }).finally(()=>{if(this.modelCheckController===controller)this.modelCheckController=null;if(this.modelCheckTask===task)this.modelCheckTask=null});this.modelCheckTask=task;this.serial=task.catch(()=>{});return task
 }
 async cancelModelCheck(){this.modelCheckController?.abort();await this.modelCheckTask?.catch(()=>{})}
 private getRuntime(){this.assertConfiguredRuntimeTerms();if(isQwenEngine(this.state.engine)){const gguf=this.state.engine==='qwen3-tts-06b-gguf',config=this.qwenConnection();if(!config)throw Error(gguf?'QWEN_GGUF_RUNTIME_MISSING':'QWEN_RUNTIME_MISSING');return this.runtime??=this.makeRuntime({...this.managedAdmission(config),modelVerification:gguf?'full':this.modelVerification,engine:this.state.engine!,qwen:this.state.qwenClone,worker:join(dirname(this.worker),gguf?'qwen_gguf_worker.py':process.platform==='darwin'?'qwen_mlx_worker.py':'qwen_worker.py'),cacheRoot:join(this.root,'cache'),executionProfile:this.activeProfile()})}if(isWindowsVoxGgufProfile(this.activeProfile())){if(!this.qwenGgufSupported())throw Error('VOX_GGUF_PLATFORM');const config=this.voxGgufConnection();if(!config)throw Error('VOX_GGUF_RUNTIME_MISSING');if(!this.selectedProfile())throw Error('VOICE_REFERENCE_UNAVAILABLE');return this.runtime??=this.makeRuntime({...this.managedAdmission(config),...(isManagedVoice(this.selectedProfile())?{ggufModelKind:'public-base' as const}:{}),engine:'voxcpm2',modelVerification:'full',worker:join(dirname(this.worker),'voxcpm_windows_gguf_worker.py'),cacheRoot:join(this.root,'cache'),executionProfile:this.activeProfile()})}const config:{python:string;model:string;nativeBase?:boolean;windowsBase?:boolean}=isManagedVoice(this.selectedProfile())?{python:this.base!.executable,model:this.base!.path,nativeBase:this.base!.native,windowsBase:!this.base!.native}:this.config!;if(this.runtime&&this.runtime.config?.nativeBase!==config.nativeBase){void this.runtime.stop().catch(()=>{});this.runtime=null}return this.runtime??=this.makeRuntime({...config,modelVerification:this.modelVerification,worker:this.worker,cacheRoot:join(this.root,'cache'),compilerCache:join(this.root,'compiler-cache'),executionProfile:this.activeProfile()})}
 private startRuntime(profile:VoiceSnapshot['profiles'][number],runtime:TtsRuntimeSupervisor,current:()=>boolean,owner:VoiceOutputOwner='local'){
  // Drain the previous owner's post-load asset checks before a successor may
  // reuse its session. A stale owner must never stop its successor's speech.
  const task=this.runtimeStartTask.then(async()=>{
   if(!current())throw Error('VOICE_CANCELLED')
   if(this.runtimeOwners?.runtime!==runtime||this.runtimeOwners.session!==runtime.sessionId||!runtime.running)this.runtimeOwners={runtime,session:runtime.sessionId,owners:new Set()}
   const ownership=this.runtimeOwners;ownership.owners.add(owner)
   try{await this.loadRuntime(profile,runtime,current)}catch(error){
    if(!current()||this.state.gpuBackend!=='auto'||voiceProfileBackend(this.activeProfile())!=='cuda'||!canRetryVoiceWithVulkan(error))throw error
    const alternative=this.state.engine==='qwen3-tts-06b-gguf'?this.qwenGgufBackends.vulkan||this.qwenGgufConfig?.ggufVulkanRuntime:isManagedVoice(profile)?this.voxPublicGgufBackends.vulkan:this.voxTrainedGgufBackends.vulkan
    // Loading may select an already connected fallback, but never downloads,
    // extracts runtimes, changes voices, or bypasses managed admission.
    if(!alternative)throw error
    await runtime.stop();if(!current())throw Error('VOICE_CANCELLED')
    this.automaticBackend='vulkan';this.runtime=null;this.verifiedBase=null
    runtime=this.getRuntime()
    this.runtimeOwners={runtime,session:runtime.sessionId,owners:new Set([owner])}
    this.diagnose({type:'gpu-backend-fallback',from:'cuda',to:'vulkan',reason:(error as Error).message})
    await this.loadRuntime(profile,runtime,current)
    if(this.runtimeOwners.runtime===runtime)this.runtimeOwners.session=runtime.sessionId
    this.emit()
    return runtime
   }
   if(this.runtimeOwners===ownership){if(ownership.session!==runtime.sessionId)ownership.owners=new Set([owner]);ownership.session=runtime.sessionId}
   return runtime
  })
  this.runtimeStartTask=task.then(()=>{},()=>{});return task
 }
 private async loadRuntime(profile:VoiceSnapshot['profiles'][number],runtime:TtsRuntimeSupervisor,current:()=>boolean){
  if(process.platform==='win32'&&!isWindowsVoxGgufProfile(this.activeProfile())&&this.blockedModels.size>0&&this.blockedModels.has(runtime.config.model.toLowerCase()))throw Error('VOICE_MODEL_CHECK_FAILED')
  let key=profile.fingerprint+':'+this.activeProfile();const started=Date.now()
  if(isQwenEngine(this.state.engine)){
   if(!isReferenceProfile(profile))throw Error('QWEN_REFERENCE_REQUIRED')
   const ref=await this.references.resolve(profileKey(profile)),clone=this.state.qwenClone||{mode:'x-vector',transcript:''}
   const fingerprint=createHash('sha256').update(JSON.stringify({engine:this.state.engine,backend:this.state.engine==='qwen3-tts-06b-gguf'?(this.activeProfile().includes('-vulkan')?'gguf-vulkan':'gguf-cuda'):process.platform==='darwin'?'mlx':'torch',revision:this.state.engine==='qwen3-tts-06b-gguf'?'b7ee2e8c7459c3bea99da23e3d178125a7d1713c':process.platform==='darwin'?'0d6bb6fe33f92d47a507e23b9148940e8366ab5b':'5d83992436eae1d760afd27aff78a71d676296fc',reference:ref.sha256,mode:clone.mode,transcript:createHash('sha256').update(clone.transcript).digest('hex'),profile:ref.fingerprint})).digest('hex')
   const identity=await this.qwenAssets(profile)
   if(!current())throw Error('VOICE_CANCELLED')
   await runtime.start('',key+':'+fingerprint+':'+identity,{...ref,fingerprint})
   if(identity!==await this.qwenAssets(profile)){await runtime.stop();throw Error('QWEN_RUNTIME_CHANGED')}
   if(!current()){await runtime.stop();throw Error('VOICE_CANCELLED')}
   return
  }
  if(isWindowsVoxGgufProfile(this.activeProfile())){
   const publicModel=isManagedVoice(profile),conditioning=isReferenceProfile(profile)?await this.references.resolve(profileKey(profile)):undefined
   const identity=await this.voxGgufAssets(profile)
   if(!current())throw Error('VOICE_CANCELLED')
   await runtime.start(publicModel?'':join(this.root,'profiles',profileKey(profile)),key+':'+identity,conditioning)
   if(identity!==await this.voxGgufAssets(profile)){await runtime.stop();throw Error('VOX_GGUF_ASSET_CHANGED')}
   if(!current()){await runtime.stop();throw Error('VOICE_CANCELLED')}
   return
  }
  if(!isManagedVoice(profile)){if(!current())throw Error('VOICE_CANCELLED');await runtime.start(join(this.root,'profiles',profileKey(profile)),key);return}
  try{
   let conditioning:ReferenceCondition|undefined
   if(isReferenceProfile(profile)){conditioning=await this.references.resolve(profileKey(profile));if(conditioning.fingerprint!==profile.fingerprint)throw Error('VOICE_REFERENCE_CHANGED')}
   const identity=await this.base!.identity(),lease=this.verifiedBase
   if(conditioning){conditioning={...conditioning,fingerprint:createHash('sha256').update(JSON.stringify({profile:conditioning.fingerprint,base:this.base!.profile.fingerprint,assets:identity,executionProfile:this.activeProfile()})).digest('hex')};key+=':'+conditioning.fingerprint}
   if(!current())throw Error('VOICE_CANCELLED')
   if(identity&&lease?.runtime===runtime&&lease.session===runtime.sessionId&&lease.key===key&&lease.identity===identity&&runtime.ready){
    this.diagnose({type:'base-verification',reused:true,verifyMs:0,metadataMs:Date.now()-started,session:runtime.sessionId});return
   }
   this.verifiedBase=null
   if(runtime.running)await runtime.stop()
   if(!current())throw Error('VOICE_CANCELLED')
   const verifying=Date.now();await this.base!.ready(this.base!.native?'full':this.modelVerification)
   const verifyMs=Date.now()-verifying
   if(!current())throw Error('VOICE_CANCELLED')
   if(identity&&identity!==await this.base!.identity())throw Error('VOICE_BASE_CHANGED')
   if(!current())throw Error('VOICE_CANCELLED')
   const loading=Date.now();await runtime.start(join(this.root,'profiles',profileKey(profile)),key,conditioning)
   if(!current())throw Error('VOICE_CANCELLED')
   if(identity&&identity!==await this.base!.identity())throw Error('VOICE_BASE_CHANGED')
   if(!current())throw Error('VOICE_CANCELLED')
   if(identity)this.verifiedBase={runtime,session:runtime.sessionId,key,identity}
   this.diagnose({type:'base-verification',reused:false,verifyMs,loadMs:Date.now()-loading,session:runtime.sessionId})
  }catch(e){this.verifiedBase=null;if(current())await runtime.stop();throw e}
 }
 prepare(manual=false):Promise<void>{
  if(this.runtimeSetupTask||this.runtimeCancelTask){if(manual)return Promise.reject(Error('GGUF_RUNTIME_BUSY'));return Promise.resolve()}
  if(this.managedTask){if(manual)return Promise.reject(Error('VOICE_MODEL_REMOVAL_BUSY'));return Promise.resolve()}
  if(this.preparing)return this.preparing
  const profile=this.selectedProfile()
  if(this.disposed||(manual&&!this.chat().character)||this.state.seedError||(!manual&&(!this.outputReady||this.outputOwner==='presentation'&&this.presentationMuted))||!this.state.enabled||!this.configured()||!profile||(!isStreamingProfile(this.activeProfile())&&!this.activeProfile().endsWith('-complete'))||this.currentSpeech||this.modelCheckTask){if(manual)return Promise.reject(Error('VOICE_PREPARATION_UNAVAILABLE'));return Promise.resolve()}
  try{this.assertConfiguredRuntimeTerms()}catch(error){this.error(error);return manual?Promise.reject(error):Promise.resolve()}
  const operation=this.operation,runtime=this.getRuntime(),character=this.chat().character,characterId=character?.id,revision=character?.revision,fingerprint=profile.fingerprint,engine=this.state.engine,execution=this.activeProfile(),gpuPreference=this.state.gpuBackend
  const current=()=>operation===this.operation&&!this.disposed&&this.state.enabled&&(manual||this.outputReady)&&this.chat().character?.id===characterId&&this.chat().character?.revision===revision&&this.selectedProfile()?.fingerprint===fingerprint&&this.state.engine===engine&&(this.activeProfile()===execution||gpuPreference==='auto'&&this.state.gpuBackend==='auto')
  this.preparationCurrent=current
  this.state.status='loading';this.state.error=null;this.emit()
  const task=this.startRuntime(profile,runtime,current).then(async(runtime)=>{
   if(!current())return
   if(isQwenEngine(this.state.engine)&&!runtime.audit?.warmed)await runtime.prewarm()
   if(current()){this.state.status='idle';this.state.error=null;this.emit();this.diagnose({type:'preparation-ready',at:Date.now(),session:runtime.sessionId,audit:runtime.audit})}
  }).catch(e=>{if(current())this.error(e)}).finally(()=>{if(this.preparing===task){this.preparing=null;this.preparationCurrent=null}})
  this.preparing=task;return task
 }
 bind(characterId:string,profile:string|null,current=()=>true){void this.stop().catch(()=>{});return this.mutate(async()=>{await this.stop();if(!current())throw Error('CHAT_SETTINGS_EXPIRED');this.runtime=null;if((profile===this.baseKey()||profile===null||!!profile&&referenceKey(profile))&&this.base?.native&&this.base.snapshot().supported&&!this.state.executionProfile?.startsWith('gguf-metal-'))this.state.executionProfile='gguf-metal-f16';if(profile&&!this.state.profiles.some(p=>profileKey(p)===profile))throw Error('VOICE_PROFILE');if(profile)this.state.bindings[characterId]=profile;else delete this.state.bindings[characterId];this.state.error=null})}
 private async removeFiles(profile:string){if(referenceKey(profile)){await this.references.remove(profile);return}await rm(join(this.root,'gguf-cache',profile),{recursive:true,force:true,maxRetries:3});await rm(join(this.root,'profiles',profile),{recursive:true,force:true,maxRetries:3})}
 remove(profile:string){
  if(profile===this.baseKey())throw Error('VOICE_BASE_BUILTIN')
  void this.stop().catch(e=>this.error(e))
  const task=this.serial.then(async()=>{
   if(this.disposed)return
   await this.stop()
   const found=this.state.profiles.some(v=>profileKey(v)===profile)
   if(!found&&!this.pendingRemoval.has(profile)){this.error(Error('VOICE_PROFILE'));return}
   if(found){
    const previous=structuredClone(this.state)
    this.state.profiles=this.state.profiles.filter(v=>profileKey(v)!==profile)
    for(const [id,key] of Object.entries(this.state.bindings))if(key===profile)delete this.state.bindings[id]
    this.pendingRemoval.add(profile)
    // The single commit point precedes deletion. A persisted tombstone prevents
    // a leftover folder from re-registering after deletion fails or the app exits.
    try{await this.save()}catch(e){this.state=previous;this.pendingRemoval.delete(profile);this.error(e);return}
   }
   try{await this.removeFiles(profile);this.state.error=null;this.emit()}
   catch{this.error(Error('VOICE_CLEANUP_PENDING'))}
  })
  this.serial=task.catch(()=>{});return task
 }
 cancel(){void this.stop(true,false).catch(e=>this.error(e))}
 requestStarted(id:string){
  if(this.observedRequests.has(id))return
  this.observedRequests.add(id)
  this.requestTimes.set(id,Date.now());if(this.requestTimes.size>1000)this.requestTimes.delete(this.requestTimes.keys().next().value!)
  if(this.outputReady&&!this.disposed)this.allowedRequests.add(id)
  if(this.observedRequests.size>1000){const old=this.observedRequests.values().next().value!;this.observedRequests.delete(old);this.allowedRequests.delete(old)}
 }
 private syncReplayScope(){const s=this.chat();if(this.replay.setScope(JSON.stringify([s.character?.id,s.character?.revision,s.conversation?.id,s.model,this.bindingKey(s.character?.id||''),this.state.engine,this.state.qwenClone,this.qwenConnection(),this.voxGgufConnection()]))){this.state.lastGeneration=undefined}}
 onChatChanged(){this.syncReplayScope();if(this.currentSpeech&&!this.currentSpeech()||this.preparationCurrent&&!this.preparationCurrent())this.cancel()}
 completed(message:ChatMessage){
  const id=message.binding?.requestId
  const allowed=!!id&&this.allowedRequests.delete(id)
  if(!allowed||!this.outputReady||!this.state.enabled||!this.state.autoRead)return
  const key=message.id+':'+this.state.bindings[message.binding?.characterId||'']
  if(this.seen.has(key))return
  this.seen.add(key);if(this.seen.size>1000)this.seen.delete(this.seen.values().next().value!)
  void this.read(message,false,true).catch(e=>this.error(e))
 }
 readMessage(id:string,mode:'read'|'replay'|'reroll'|'reproduce'='read'){const m=this.chat().conversation?.messages.find(m=>m.id===id);if(!m)throw Error('VOICE_MESSAGE');void this.read(m,false,false,mode).catch(e=>this.error(e))}
 test(){const chat=this.chat(),character=chat.character;if(!character)throw Error('VOICE_CHARACTER');const id=randomUUID();void this.read({id,role:'assistant',status:'complete',text:'응, 듣고 있어. 지금은 어떤 이야기를 할까?',createdAt:new Date().toISOString(),binding:{characterId:character.id,revision:character.revision,conversationId:chat.conversation?.id||'',personaHash:'test',semanticHash:'test',modelId:chat.model,requestId:id,epoch:chat.epoch}},true).catch(e=>this.error(e))}
 async speakPresentation(text:string,signal:AbortSignal){
  const s=this.snapshot(),chat=this.chat(),character=chat.character
  if(signal.aborted)throw Error('VOICE_CANCELLED')
  if(!this.outputReady)throw Error('VOICE_OUTPUT_NOT_READY')
  if(this.presentationMuted||!s.enabled||!s.runtimeConfigured||!character||s.seedError||!s.availableProfiles?.length)throw Error('VOICE_PRESENTATION_UNAVAILABLE')
  if(typeof text!=='string'||!text.trim()||[...text].length>600)throw Error('VOICE_MESSAGE')
  let operation=this.operation
  const id=randomUUID(),abort=()=>{if(operation===this.operation&&this.speechOwner==='presentation')void this.stop(true,false).catch(e=>this.error(e))}
  signal.addEventListener('abort',abort,{once:true})
  try{const task=this.read({id,role:'assistant',status:'complete',text,createdAt:new Date().toISOString(),binding:{characterId:character.id,revision:character.revision,conversationId:chat.conversation?.id||'',personaHash:'presentation',semanticHash:'presentation',modelId:chat.model,requestId:id,epoch:chat.epoch}},true,false,'read',()=>!signal.aborted,'presentation');operation=this.operation;await task;if(!signal.aborted&&this.state.status==='error')throw Error(this.state.error||'VOICE_ERROR');if(!signal.aborted&&this.state.status!=='idle')throw Error('VOICE_CANCELLED')}
  finally{signal.removeEventListener('abort',abort);this.replay.forget(id);if(this.state.lastGeneration?.messageId===id){this.state.lastGeneration=undefined;this.emit()}}
 }
 private async read(message:ChatMessage,test=false,automatic=false,mode:'read'|'replay'|'reroll'|'reproduce'='read',permitted=()=>true,owner:VoiceOutputOwner='local'){
  this.assertModelsAvailable()
  const requestedAt=Date.now()
  if(this.disposed||!this.outputReady||owner==='presentation'&&this.presentationMuted||!this.state.enabled||this.modelCheckTask)return
  if(message.role!=='assistant'||message.status!=='complete'||!message.binding)throw Error('VOICE_MESSAGE')
  if(this.state.seedError&&mode!=='replay')throw Error('VOICE_SEED_SETTINGS')
  this.syncReplayScope()
  const seedSettings={...(this.state.seedSettings||DEFAULT_VOICE_SEED)}
  let executionProfile=this.activeProfile()
  const before=this.chat(),source=structuredClone(message),profile=this.selectedProfile()
  if(!profile)throw Error(referenceKey(this.bindingKey(before.character?.id||''))?'VOICE_REFERENCE_UNAVAILABLE':'VOICE_NOT_INSTALLED');if(isReferenceProfile(profile)&&profile.error)throw Error(profile.error);if(mode!=='replay'&&!this.configured())throw Error(isManagedVoice(profile)?'VOICE_BASE_NOT_INSTALLED':'VOICE_RUNTIME_MISSING')
  const op=++this.operation
  // stop() retires currentSpeech before asynchronous cancellation drains. Keep
  // read-only metadata out of that gap until the successor owns currentSpeech.
  ++this.speechHandoffs
  try{await this.stop(false)}finally{--this.speechHandoffs}
  if(op!==this.operation||this.disposed)return
  const epoch=this.state.epoch,origin=before.character
  const current=()=>{const s=this.chat();return permitted()&&(owner!=='presentation'||!this.presentationMuted)&&!this.disposed&&this.outputReady&&this.state.enabled&&op===this.operation&&epoch===this.state.epoch&&s.character?.id===source.binding!.characterId&&s.character.revision===source.binding!.revision&&s.epoch===before.epoch&&s.model===before.model&&s.conversation?.id===before.conversation?.id&&this.bindingKey(s.character.id)===profileKey(profile)&&(test||!!s.conversation?.messages.some(m=>m.id===source.id&&m.status==='complete'&&m.text===source.text))}
  if(!origin||!current())return
  this.currentSpeech=current;this.speechOwner=owner
  let candidate:ReplayCandidate|undefined
  try {
   const plan=planSpeech(source.text,this.speechPolicy),segments=plan.segments
   this.diagnose({type:'speech-plan',policy:plan.policy,preferredLength:plan.preferredLength,segments:segments.map(({start,end,index,cutReason,readableGraphemes,tinyReason})=>({start,end,index,cutReason,readableGraphemes,tinyReason}))})
   const speechPlanFingerprint=createHash('sha256').update(JSON.stringify(plan)).digest('hex')
   let identity=await this.replayIdentity(source,profile,speechPlanFingerprint,executionProfile)
   if(!current())return
   const previousResult=this.replay.previous(source.id,identity)
   if(mode==='replay'){
    const recorded=this.replay.get(source.id,identity)
    if(!recorded){if(!previousResult)this.replay.forget(source.id);throw Error('VOICE_REPLAY_MISSING')}
    this.speechStartedAt=requestedAt;this.firstPlayback=false;this.lastPlaybackEndAt=0;this.spokenRequestAt=0
    const binding:PlaybackBinding={...source.binding!,messageId:source.id,speechEpoch:epoch,voiceProfileId:profile.id,voiceProfileVersion:profile.version,voiceFingerprint:profile.fingerprint,playbackId:randomUUID(),sourceGenerationId:recorded.plan.generationId,effectiveSeed:recorded.plan.effectiveSeed}
    this.diagnose({type:'voice-replay',generationId:recorded.plan.generationId,effectiveSeed:recorded.plan.effectiveSeed,cache:'hit'})
    const streams=new Map<number,string>(),inflight:Promise<void>[]=[]
    for(const part of recorded.parts){
     if(!current())return
     if(createHash('sha256').update(part.bytes).digest('hex')!==part.hash)throw Error('VOICE_REPLAY_CHANGED')
     const durationMs=(part.bytes.byteLength-44)/96,audio={audioId:randomUUID(),bytes:Uint8Array.from(part.bytes),durationMs,generationMs:0,rtf:0}
     if(part.stream){if(!streams.has(part.segmentIndex))streams.set(part.segmentIndex,randomUUID());inflight.push(this.enqueueChunk({...audio,...part.stream,synthesisId:streams.get(part.segmentIndex)!,firstChunkReadyMs:0},binding,part.segmentIndex));if(inflight.length>=3)await inflight.shift()}
     else{await Promise.all(inflight.splice(0));await this.playComplete(audio,binding,part.segmentIndex)}
    }
    await Promise.all(inflight)
    if(current()){this.currentSpeech=null;this.state.status='idle';this.emit()}return
   }
   if(mode==='reproduce'&&!previousResult){this.replay.forget(source.id);throw Error('VOICE_REPRODUCE_CHANGED')}
   let effectiveSeed=mode==='reproduce'?previousResult!.effectiveSeed:seedSettings.mode==='fixed'&&mode!=='reroll'?seedSettings.fixedSeed:this.chooseRandom()
   if(mode==='reroll'&&previousResult&&effectiveSeed===previousResult.effectiveSeed){
    // Uniform draw over the remaining range; production retries unbiased OS draws.
    let attempts=0;do{if(++attempts>32)throw Error('VOICE_SEED_INVALID');effectiveSeed=this.chooseRandom()}while(effectiveSeed===previousResult.effectiveSeed)
   }
   if(!validVoiceSeed(effectiveSeed))throw Error('VOICE_SEED_INVALID')
   const generation:VoiceGenerationPlan=Object.freeze({generationId:randomUUID(),effectiveSeed,seedPolicy:mode==='reroll'?'reroll':mode==='reproduce'?'reproduce':seedSettings.mode,messageId:source.id,voiceFingerprint:profile.fingerprint,speechPlanFingerprint})
   this.diagnose({type:'voice-generation',...generation,cache:'miss'})
   let runtime=this.getRuntime()
   this.speechStartedAt=requestedAt;this.spokenRequestAt=automatic?(this.requestTimes.get(source.binding!.requestId)||this.speechStartedAt):0;this.firstPlayback=false;this.lastPlaybackEndAt=0
   this.state.error=null;this.state.status=runtime.running?'synthesizing':'loading';this.emit()
   if(!current())return
   runtime=await this.startRuntime(profile,runtime,current,owner)
   if(!current())return
   if(executionProfile!==this.activeProfile()){
    if(mode==='reproduce')throw Error('VOICE_REPRODUCE_CHANGED')
    executionProfile=this.activeProfile();identity=await this.replayIdentity(source,profile,speechPlanFingerprint,executionProfile)
    if(!current())return
   }
   this.diagnose({type:'runtime-ready',at:Date.now(),session:runtime.sessionId,audit:runtime.audit})
   candidate=this.replay.begin(identity,generation,{runtimeFingerprint:runtime.audit?.runtimeFingerprint,modelRevision:runtime.audit?.modelRevision,sourceCommit:runtime.audit?.sourceCommit,adapterSha256:runtime.audit?.adapterSha256,referenceSha256:runtime.audit?.referenceSha256,executionProfile})
   const binding:SpeechBinding={engine:this.state.engine||'voxcpm2',effectiveSeed:generation.effectiveSeed,generationId:generation.generationId,...source.binding!,messageId:source.id,speechEpoch:epoch,voiceProfileId:profile.id,voiceProfileVersion:profile.version,voiceFingerprint:profile.fingerprint,runtimeSessionId:runtime.sessionId,executionProfile,...(isReferenceProfile(profile)?{conditioningFingerprint:String(runtime.audit?.conditioningFingerprint||'')}: {})}
   if(isStreamingProfile(binding.executionProfile)){
    let previous=Promise.resolve()
    for(const segment of segments){
     if(!current())return
     if(!segment.text.trim())continue
     const consumed:Promise<void>[]=[]
     this.state.status='synthesizing';this.emit()
     const result=await runtime.stream(segment.text,binding,segment.index,audio=>{
      if(!current())return Promise.reject(Error('VOICE_CANCELLED'))
      this.replay.append(candidate!,audio.bytes,segment.index,{chunkIndex:audio.chunkIndex,sampleOffset:audio.sampleOffset,sampleCount:audio.sampleCount})
      const done=this.enqueueChunk(audio,binding,segment.index);consumed.push(done);return done
     })
     if(!current())return
     this.diagnose({type:'synthesis-finished',at:Date.now(),epoch,index:segment.index,...result})
     const drained=Promise.all(consumed).then(()=>{});void drained.catch(()=>{})
     // GPU may generate only the immediate successor while its predecessor plays.
     await previous;previous=drained
    }
    await previous
   }else{
   for(const segment of segments){
    if(!current())return
    if(!segment.text.trim())continue
    this.state.status='synthesizing';this.emit()
    if(!current())return
    const audio=await runtime.synthesize(segment.text,binding,segment.index)
    if(!current())return
    this.diagnose({type:'audio-ready',at:Date.now(),epoch,index:segment.index,audioId:audio.audioId,textLength:segment.text.length,durationMs:audio.durationMs,generationMs:audio.generationMs,rtf:audio.rtf,peakAllocatedBytes:audio.peakAllocatedBytes,peakReservedBytes:audio.peakReservedBytes})
    this.replay.append(candidate!,audio.bytes,segment.index)
    await this.playComplete(audio,binding,segment.index)
   }
   }
   if(current()){this.state.lastGeneration=this.replay.publish(candidate!);candidate=undefined;this.currentSpeech=null;this.state.status='idle';this.emit()}
  }catch(e){if(current()){await this.stop(true,true,false);this.error(e)}}finally{if(candidate)this.replay.discard(candidate)}
 }
 private async qwenAssets(profile:VoiceSnapshot['profiles'][number]){
  if(this.state.engine==='qwen3-tts-06b-gguf'){
   const config=this.qwenConnection() as QwenGgufConnection
   if(config.managedRuntime)return new VoiceAssetIdentity(profile.fingerprint,[config.model,config.ggufRuntime,dirname(this.worker),dirname(config.python),...(config.dependencyDirs??[])],[{path:await realpath(config.python)},{path:config.managedRuntime.receipt}]).snapshot()
   const env=dirname(dirname(config.python)),site=join(env,'Lib','site-packages')
   // Inventory only this bridge's dependencies, avoiding the unused PyTorch tree.
   // Metadata invalidates a warm lease; the worker verifies content pins on load.
   const entries=await readdir(site,{withFileTypes:true}),roots=entries.filter(e=>e.isDirectory()&&/^(numpy(?:\.libs|-[\d.]+\.dist-info)?|scipy(?:\.libs|-[\d.]+\.dist-info)?|soundfile-[\d.]+\.dist-info|_soundfile_data)$/.test(e.name)).map(e=>join(site,e.name))
   return new VoiceAssetIdentity(profile.fingerprint,[config.model,config.ggufRuntime,dirname(this.worker),...roots],[{path:await realpath(config.python)},{path:join(env,'pyvenv.cfg')},{path:join(site,'soundfile.py')}]).snapshot()
  }
  const env=dirname(dirname(this.qwenConfig!.python)),mac=process.platform==='darwin'
  // A standard Mac venv has interpreter symlinks in bin. Inventory its installed
  // lib tree, receipt/config, and resolved interpreter without relaxing model or
  // dependency link checks. The worker verifies the actual interpreter hash.
  return new VoiceAssetIdentity(profile.fingerprint,[this.qwenConfig!.model,dirname(this.worker),mac?join(env,'lib'):env],[{path:await realpath(this.qwenConfig!.python)},...(mac?[{path:join(env,'pyvenv.cfg')},{path:join(env,'qwen-runtime.json')}]:[])]).snapshot()
 }
 private async voxGgufAssets(profile:VoiceSnapshot['profiles'][number]){const config=this.voxGgufConnection()!;return new VoiceAssetIdentity(profile.fingerprint,[config.model,config.gguf.runtimeDir,config.gguf.derivativeDir,dirname(this.worker),...(config.managedRuntime?[dirname(config.python),...(config.dependencyDirs??[])]:[]),...(isManagedVoice(profile)?[]:[join(this.root,'profiles',profileKey(profile))])],[{path:await realpath(config.python)},{path:config.gguf.receipt},...(config.managedRuntime?[{path:config.managedRuntime.receipt}]:[])]).snapshot()}
 private async replayAssets(profile:VoiceSnapshot['profiles'][number]){return new VoiceAssetIdentity(profile.fingerprint,[this.config!.model,dirname(this.worker),dirname(dirname(this.config!.python)),join(this.root,'profiles',profileKey(profile))],[{path:await realpath(this.config!.python)}]).snapshot()}
 private async replayIdentity(message:ChatMessage,profile:VoiceSnapshot['profiles'][number],speechPlan:string,execution:ExecutionProfile){
  const reference=isReferenceProfile(profile)?(await this.references.resolve(profileKey(profile))).sha256:undefined
  const assets=isQwenEngine(this.state.engine)?await this.qwenAssets(profile):isWindowsVoxGgufProfile(execution)?await this.voxGgufAssets(profile):isManagedVoice(profile)?await this.base!.identity():await this.replayAssets(profile)
  return createHash('sha256').update(JSON.stringify({engine:this.state.engine,qwenClone:isQwenEngine(this.state.engine)?this.state.qwenClone:null,qwenConfig:isQwenEngine(this.state.engine)?this.qwenConnection():null,binding:message.binding,messageId:message.id,text:message.text,profile:profile.fingerprint,reference,assets,execution,speechPlan,config:isWindowsVoxGgufProfile(execution)?this.voxGgufConnection():isManagedVoice(profile)?null:this.config})).digest('hex')
 }
 private playComplete(audio:{audioId:string;bytes:Uint8Array;durationMs:number},binding:PlaybackBinding,segmentIndex:number){
  return new Promise<void>((resolve,reject)=>{const epoch=binding.speechEpoch,timer=setTimeout(()=>{if(this.active?.id===audio.audioId){this.active=null;reject(Error('VOICE_PLAYBACK_TIMEOUT'))}},audio.durationMs+30_000);this.active={id:audio.audioId,epoch,bytes:audio.bytes,claimed:false,resolve,reject,timer};this.state.status='playing';this.emit();this.notify({type:'audio',audioId:audio.audioId,epoch,binding,segmentIndex})})
 }
 private enqueueChunk(audio:AudioChunk,binding:PlaybackBinding,segmentIndex:number){
  if(this.chunks.size>=6||[...this.chunks.values()].reduce((n,a)=>n+a.durationMs,0)+audio.durationMs>6000)throw Error('VOICE_QUEUE_LIMIT')
  const done=new Promise<void>((resolve,reject)=>{
   const timer=setTimeout(()=>{this.chunks.delete(audio.audioId);reject(Error('VOICE_PLAYBACK_TIMEOUT'))},30_000)
   this.chunks.set(audio.audioId,{epoch:binding.speechEpoch,bytes:audio.bytes,durationMs:audio.durationMs,claimed:false,resolve,reject,timer,segmentIndex,chunkIndex:audio.chunkIndex})
   this.state.status='playing';this.emit()
   this.diagnose({type:'audio-chunk',at:Date.now(),epoch:binding.speechEpoch,index:segmentIndex,chunkIndex:audio.chunkIndex,durationMs:audio.durationMs,firstChunkReadyMs:audio.firstChunkReadyMs})
   this.notify({type:'audio',audioId:audio.audioId,epoch:binding.speechEpoch,binding,segmentIndex,stream:{synthesisId:audio.synthesisId,chunkIndex:audio.chunkIndex,sampleOffset:audio.sampleOffset,sampleCount:audio.sampleCount}})
  });void done.catch(()=>{});return done
 }
 scheduled(id:string,epoch:number,delayMs:number,gapMs:number){
  const chunk=this.chunks.get(id),active=chunk||(this.active?.id===id?this.active:null)
  if(!active?.claimed||active.epoch!==epoch||epoch!==this.state.epoch)return
  this.diagnose({type:'playback-scheduled',at:Date.now(),epoch,audioId:id,first:!this.firstPlayback,firstPlaybackMs:this.firstPlayback?undefined:Date.now()-this.speechStartedAt+delayMs,endToEndFirstAudioMs:this.firstPlayback||!this.spokenRequestAt?undefined:Date.now()-this.spokenRequestAt+delayMs,delayMs,gapMs:chunk?gapMs:this.lastPlaybackEndAt?Date.now()-this.lastPlaybackEndAt:0,index:chunk?.segmentIndex,chunkIndex:chunk?.chunkIndex})
  this.firstPlayback=true;return true
 }
 audio(id:string,epoch:number){const a=this.chunks.get(id)||(this.active?.id===id?this.active:null);if(!a||a.epoch!==epoch||epoch!==this.state.epoch||a.claimed||!this.currentSpeech?.())throw Error('VOICE_AUDIO_EXPIRED');a.claimed=true;const bytes=a.bytes;if(this.chunks.has(id))a.bytes=new Uint8Array();return bytes}
 played(id:string,epoch:number,error=false){const a=this.chunks.get(id)||(this.active?.id===id?this.active:null);if(!a||a.epoch!==epoch)return;this.chunks.delete(id);if(this.active?.id===id)this.active=null;clearTimeout(a.timer);this.lastPlaybackEndAt=Date.now();this.diagnose({type:error?'playback-error':'playback-ended',at:Date.now(),epoch,audioId:id,claimed:a.claimed});if(error)a.reject(Error('VOICE_PLAYBACK'));else if(a.claimed)a.resolve();else a.reject(Error('VOICE_PLAYBACK_UNCLAIMED'))}
 /** Revoke the presentation lease before asynchronous owned cleanup, then restore its truthful outcome. */
 async releasePresentationOutput(outcome:'completed'|'cancelled'|'failed'='cancelled',failure?:unknown){
  this.outputReady=false;this.allowedRequests.clear()
  const pending=this.stop(true,outcome==='failed'),epoch=this.state.epoch
  await pending
  if(this.disposed||this.outputReady||this.state.epoch!==epoch)return
  if(outcome==='failed')this.error(failure)
  else if(outcome==='completed'){this.state.status=this.state.enabled?'idle':'off';this.emit()}
 }
 async stop(invalidate=true,unload=true,clearReplay=invalidate&&unload,preserveModelCheck=false){
  const stopStartedAt=Date.now()
  const hadSpeech=!!this.currentSpeech
  this.replay.discardPending()
  if(!preserveModelCheck)this.modelCheckController?.abort()
  const verification=this.base?.cancelVerification()
  if(clearReplay){this.replay.clear();this.state.lastGeneration=undefined}
  if(invalidate)++this.operation
  if(invalidate&&unload)this.runtimeOwners=null
  ++this.state.epoch;this.currentSpeech=null
  // Revoke producer callbacks before resolving consumers. The same warm child
  // may already accept a new speech while retired final-chunk IO is completing.
  this.runtime?.retireSpeech()
  this.notify({type:'stop',epoch:this.state.epoch,requestedAt:stopStartedAt})
  this.diagnose({type:'speech-invalidated',at:Date.now(),epoch:this.state.epoch})
  if(this.active){clearTimeout(this.active.timer);this.active.resolve();this.active=null}
  for(const a of this.chunks.values()){clearTimeout(a.timer);a.resolve()}this.chunks.clear()
  this.state.status=this.state.enabled?'stopped':'off';this.emit()
  // OFF/mute/close/runtime changes unload. Output loss and voice-only stop/replacement
  // waits for owner-thread cleanup before reusing an active streaming worker.
  try{if(this.runtime&&((invalidate&&unload)||(this.state.engine==='qwen3-tts-06b'&&this.runtime.busy===true)||(invalidate&&this.runtime.busy===true)||(!!this.preparing&&this.runtime.busy===true)||(hadSpeech&&this.runtime.busy!==false)||this.runtime.cancellationPending)){
   try{
    if(invalidate&&unload){await this.runtime.stop();this.diagnose({type:'worker-stopped',at:Date.now(),workerStopMs:Date.now()-stopStartedAt})}
    else {const result=await this.runtime.cancelSpeech();this.diagnose({type:'speech-cancelled',at:Date.now(),...result})}
   }
   catch(e){this.diagnose({type:'worker-stop-failed',at:Date.now()});this.error(e);throw e}
  }}finally{await verification}
 }
 outputStopped(epoch:number,elapsedMs:number){if(epoch===this.state.epoch)this.diagnose({type:'output-stopped',at:Date.now(),epoch,mainActionToRendererStopMs:elapsedMs})}
 async close(){this.disposed=true;this.outputReady=false;this.allowedRequests.clear();const installation=Promise.all([this.cancelPrepareVoiceFiles(),this.cancelInstallBase(),this.cancelInstallQwen(),this.cancelInstallGgufModel(),this.cancelInstallGgufRuntime(),this.cancelReferenceImport()]);void installation.catch(()=>{});try{await this.stop()}finally{await installation;await this.managedTask?.catch(()=>{});await this.serial.catch(()=>{})}}
}
