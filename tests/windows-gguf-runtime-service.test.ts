import {ManagedRuntimeTerms} from '../electron/main/character-voice/ManagedRuntimeTerms'
import termsPolicy from '../electron/voice/managed-runtime-terms.json'
import {resolve} from 'node:path'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname,join} from 'node:path'
import {CharacterVoiceService} from '../electron/main/character-voice/CharacterVoiceService'
import {BASE_VOICE} from '../electron/main/character-voice/VoiceBaseInstaller'
import type {TtsConfig} from '../electron/main/character-voice/TtsRuntimeSupervisor'
import type {GgufRuntimeCatalog,GgufRuntimeConnection,GgufRuntimeId,GgufRuntimeInstallState} from '../electron/shared/windows-gguf-runtime-catalog'
import {GGUF_MODEL_CATALOG} from '../electron/shared/windows-gguf-model-catalog'
import type {GgufModelId,GgufModelInstallState,ReferenceVoiceProfile} from '../electron/shared/character-voice-contract'
const platform=Object.getOwnPropertyDescriptor(process,'platform')!,arch=Object.getOwnPropertyDescriptor(process,'arch')!
const cleanup:Array<()=>Promise<void>>=[],release:Array<()=>void>=[]
const ids:GgufRuntimeId[]=['qwen-cuda','qwen-vulkan','vox-cuda','vox-vulkan']
const reference:ReferenceVoiceProfile={id:'wav-fixture',version:'1',name:'Fixture WAV',kind:'wav-reference',fingerprint:'a'.repeat(64),referenceSha256:'b'.repeat(64),reference:{durationMs:2000,sampleRate:24000,channels:1,encoding:'pcm16',samples:48000,bytes:96044}}
beforeEach(()=>{Object.defineProperty(process,'platform',{...platform,value:'win32'});Object.defineProperty(process,'arch',{...arch,value:'x64'})})
afterEach(async()=>{release.splice(0).forEach(fn=>fn());for(const fn of cleanup.splice(0))await fn();Object.defineProperty(process,'platform',platform);Object.defineProperty(process,'arch',arch);vi.restoreAllMocks()})
function gate(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);release.push(resolve);return{promise,resolve}}
async function fixture(installed=true){
 const root=await mkdtemp(join(tmpdir(),'gguf-runtime-service-')),worker=join(root,'bridge','worker.py'),runtimeRoot=join(root,'gguf-runtimes'),python=join(runtimeRoot,'components','shared','1'.repeat(64),'python','python.exe'),dependency=join(runtimeRoot,'components','shared','1'.repeat(64),'vc'),qwenModel=join(root,'model-qwen'),voxModel=join(root,'model-vox')
 for(const p of [dirname(worker),dirname(python),dependency,qwenModel,voxModel])await mkdir(p,{recursive:true})
 await Promise.all([writeFile(worker,'# fixture only; never executed'),writeFile(python,'fixture-only Python'),writeFile(join(qwenModel,'model.gguf'),'fixture'),writeFile(join(voxModel,'model.gguf'),'fixture')])
 const connections={} as Record<GgufRuntimeId,GgufRuntimeConnection>
 for(const id of ids){const runtimeDir=join(runtimeRoot,'components',id,'2'.repeat(64),'native'),receipt=join(dirname(runtimeDir),'meta','native-build.json'),active=join(runtimeRoot,'active',id+'.json');for(const p of [runtimeDir,dirname(receipt),dirname(active)])await mkdir(p,{recursive:true});await Promise.all([writeFile(receipt,'{}'),writeFile(active,'{}')]);connections[id]={id,python,runtimeDir,...(id.startsWith('vox')?{receipt}:{}),dependencyDirs:[dependency],managedRuntime:{root:runtimeRoot,receipt:active,runtimeId:id}}}
 const states:GgufRuntimeInstallState[]=ids.map(id=>({id,supported:true,available:true,repairAvailable:true,installed:false,verified:false,phase:'idle',bytes:0,total:10,error:null}))
 const connect=async(id:GgufRuntimeId)=>{Object.assign(states.find(s=>s.id===id)!,connections[id],{installed:true,verified:true});return connections[id]}
 const installer={initialize:vi.fn(async()=>{}),snapshot:()=>structuredClone(states),install:vi.fn(connect),repair:vi.fn(connect),verify:vi.fn(connect),cancel:vi.fn(async()=>{})}
 const modelStates:GgufModelInstallState[]=GGUF_MODEL_CATALOG.models.map(m=>({id:m.id,supported:true,installed,verified:installed,phase:'idle',bytes:0,total:10,error:null,verification:'sha256',runtimeIncluded:false,...(installed?{modelPath:m.id.startsWith('qwen')?qwenModel:voxModel}:{})}))
 const models={initialize:vi.fn(async()=>{}),snapshot:()=>structuredClone(modelStates),cancel:vi.fn(async()=>{}),install:vi.fn(async(id:GgufModelId)=>{const model=id.startsWith('qwen')?qwenModel:voxModel;Object.assign(modelStates.find(s=>s.id===id)!,{installed:true,verified:true,modelPath:model});return{id,model}}),verify:vi.fn(async(id:GgufModelId)=>id.startsWith('qwen')?qwenModel:voxModel),modelRemoval:vi.fn(async()=>null),removeModel:vi.fn(async()=>{})}
 const base={native:false,profile:BASE_VOICE,path:join(root,'original-model'),executable:python,initialize:vi.fn(async()=>{}),snapshot:()=>({supported:true,installed:false,phase:'idle',bytes:0,total:10,error:null}),cancel:vi.fn(async()=>{}),cancelVerification:vi.fn(async()=>{}),install:vi.fn(async()=>{})}
 const store={initialize:vi.fn(async()=>{}),list:()=>[reference],resolve:vi.fn(async()=>({kind:'wav-reference',path:join(root,'ref.wav'),sha256:reference.referenceSha256,fingerprint:reference.fingerprint,preprocessingVersion:'mono-pcm16-round-v1',sampleRate:24000,samples:48000})),close:vi.fn(async()=>{})}
 const runtimes:any[]=[];const make=vi.fn((config:TtsConfig)=>{const runtime:any={config,sessionId:'fixture-'+runtimes.length,running:false,busy:false,audit:{warmed:true},get ready(){return this.running},start:vi.fn(async()=>{await config.beforeManagedSpawn?.();runtime.running=true}),prewarm:vi.fn(async()=>{}),stop:vi.fn(async()=>{runtime.running=false}),retireSpeech:vi.fn(),cancelSpeech:vi.fn(async()=>({}))};runtimes.push(runtime);return runtime})
 const catalogRuntimes={} as GgufRuntimeCatalog['runtimes']
 for(const id of ids)catalogRuntimes[id]={id,engine:id.startsWith('qwen')?'qwen3-tts-06b-gguf':'voxcpm2',backend:id.endsWith('cuda')?'CUDA0':'Vulkan0',available:true,components:['shared'],python:{component:'shared',path:'python/python.exe'},native:{component:'shared',path:'native'},dependencyDirs:[],pythonVersion:'3.11.15'}
 const catalog:GgufRuntimeCatalog={schemaVersion:1,components:{shared:{id:'shared',archive:{name:'fixture.zip',bytes:10,sha256:'1'.repeat(64),format:'zip'},files:{'private-file':{bytes:1,sha256:'2'.repeat(64)}},provenance:{largeNeverSent:'x'.repeat(700000)}}},runtimes:catalogRuntimes}
 const services:CharacterVoiceService[]=[]
 const create=()=>{const s=new CharacterVoiceService(root,worker,()=>({character:{id:'gpichan',revision:'1'}}) as any,()=>{},()=>{},make as any,undefined,base as any,undefined,store as any);s.attachGgufInstaller(models);s.attachGgufRuntimeInstaller(installer,catalog);services.push(s);return s}
 await writeFile(join(root,'settings.json'),JSON.stringify({version:1,engine:'voxcpm2',enabled:false,autoRead:true,volume:.8,bindings:{},executionProfile:'baseline',baseExecutionProfile:'cuda-compiled'}))
 const service=create();await service.initialize()
 cleanup.push(async()=>{for(const s of services)await s.close();await rm(root,{recursive:true,force:true})})
 const selectQwen=async()=>{await service.engine('qwen3-tts-06b-gguf');await service.bind('gpichan','wav-fixture@1')}
 const saved=async()=>JSON.parse(await readFile(join(root,'settings.json'),'utf8'))
 return{root,catalog,worker,python,dependency,qwenModel,voxModel,connections,installer,models,modelStates,service,make,runtimes,selectQwen,saved,create}
}
it('connects the current backend with verified managed model paths without enabling voice or changing the engine',async()=>{
 const f=await fixture();await f.selectQwen();await f.service.setupGgufRuntime('qwen-cuda','install')
 expect(f.models.verify).toHaveBeenCalledWith('qwen3-tts-06b-gguf');expect(f.service.snapshot()).toMatchObject({engine:'qwen3-tts-06b-gguf',enabled:false,qwenGgufConfigured:true,runtimeConfigured:true,status:'off',ggufRuntimeSetup:{busy:false,application:'connected'}})
 expect(f.make).not.toHaveBeenCalled();expect((await f.saved()).qwenGgufBackends.cuda).toMatchObject({python:f.python,model:f.qwenModel,ggufRuntime:f.connections['qwen-cuda'].runtimeDir,managedRuntime:f.connections['qwen-cuda'].managedRuntime})
})
it('auto prepares both backend connections with one shared model download',async()=>{
 const f=await fixture(false);await f.selectQwen();await f.service.gpuBackend('auto')
 await f.service.prepareVoiceFiles()
 expect(f.models.install).toHaveBeenCalledTimes(1)
 expect(f.installer.install.mock.calls.map(([id])=>id)).toEqual(['qwen-cuda','qwen-vulkan'])
 const saved=await f.saved();expect(saved.gpuBackend).toBe('auto')
 expect(saved.qwenGgufBackends.cuda.model).toBe(saved.qwenGgufBackends.vulkan.model)
 expect(f.service.snapshot()).toMatchObject({gpuBackend:'auto',executionProfile:'qwen-gguf',enabled:false,filePreparation:{busy:false,phase:'connected'}})
 expect(f.make).not.toHaveBeenCalled()
})
it('auto detects Vulkan independently of the chat preference and preserves complete playback',async()=>{
 const f=await fixture();await f.selectQwen();await f.service.executionProfile('qwen-gguf-complete')
 f.service.attachGpuDetector(async()=> 'vulkan');await f.service.gpuBackend('auto')
 expect(f.service.snapshot()).toMatchObject({gpuBackend:'auto',resolvedGpuBackend:'vulkan',executionProfile:'qwen-gguf-vulkan-complete'})
 await f.service.prepareVoiceFiles()
 expect(f.installer.install.mock.calls.map(([id])=>id)).toEqual(['qwen-vulkan','qwen-cuda'])
 expect((await f.saved()).gpuBackend).toBe('auto')
})
it('auto retries a failed CUDA initialization with an already connected Vulkan runtime',async()=>{
 const f=await fixture();await f.selectQwen();await f.service.gpuBackend('auto');await f.service.prepareVoiceFiles();await f.service.enabled(true)
 const cuda=(f.service as any).getRuntime();cuda.start.mockRejectedValueOnce(Error('GGUF_MANAGED_DRIVER_UNSUPPORTED'))
 await f.service.prepare(true)
 expect(cuda.stop).toHaveBeenCalled();expect(f.runtimes).toHaveLength(2)
 expect(f.runtimes[1].config.executionProfile).toBe('qwen-gguf-vulkan')
 expect(f.service.snapshot()).toMatchObject({gpuBackend:'auto',gpuFallback:true,executionProfile:'qwen-gguf-vulkan',engineReady:true,status:'idle',error:null})
 expect(f.installer.install).toHaveBeenCalledTimes(2) // Only the explicit file preparation installed anything.
})
it('explicit CUDA never falls back and asset-integrity failures never trigger automatic fallback',async()=>{
 for(const [preference,error] of [['cuda','GGUF_MANAGED_DRIVER_UNSUPPORTED'],['auto','QWEN_GGUF_ASSET_CHANGED']] as const){
  const f=await fixture();await f.selectQwen();await f.service.gpuBackend('auto');await f.service.prepareVoiceFiles();await f.service.gpuBackend(preference);await f.service.enabled(true)
  const cuda=(f.service as any).getRuntime();cuda.start.mockRejectedValueOnce(Error(error))
  await f.service.prepare(true)
  expect(f.runtimes).toHaveLength(1);expect(f.service.snapshot()).toMatchObject({executionProfile:'qwen-gguf',status:'error',error})
 }
})
it('keeps an older explicitly selected Vulkan mode after settings migration',async()=>{
 const f=await fixture();await f.selectQwen();await f.service.executionProfile('qwen-gguf-vulkan-complete');await f.service.close()
 const saved=await f.saved();delete saved.gpuBackend;await writeFile(join(f.root,'settings.json'),JSON.stringify(saved))
 const reopened=f.create();const detect=vi.fn(async()=> 'cuda' as const);reopened.attachGpuDetector(detect);await reopened.initialize()
 expect(reopened.snapshot()).toMatchObject({gpuBackend:'vulkan',executionProfile:'qwen-gguf-vulkan-complete'})
 expect(detect).not.toHaveBeenCalled()
})
it('retains runtime-first model-required state and connects on a single later runtime check after model download',async()=>{
 const f=await fixture(false);await f.selectQwen();await f.service.setupGgufRuntime('qwen-cuda','install');expect(f.service.snapshot()).toMatchObject({qwenGgufConfigured:false,ggufRuntimeSetup:{application:'model-required'}})
 await f.service.installGgufModel('qwen3-tts-06b-gguf');expect(f.service.snapshot().engine).toBe('qwen3-tts-06b-gguf');expect(f.service.snapshot().qwenGgufConfigured).toBe(false)
 await f.service.setupGgufRuntime('qwen-cuda','verify');expect(f.service.snapshot()).toMatchObject({qwenGgufConfigured:true,enabled:false,ggufRuntimeSetup:{application:'connected'}});expect(f.make).not.toHaveBeenCalled()
})
it('does not apply a completed runtime when the initiating settings context expires',async()=>{
 const f=await fixture(),g=gate();await f.selectQwen();let current=true;f.installer.install.mockImplementation(async id=>{await g.promise;return f.connections[id]})
 const pending=f.service.setupGgufRuntime('qwen-cuda','install',()=>current);await vi.waitFor(()=>expect(f.installer.install).toHaveBeenCalled());current=false;g.resolve();await pending
 expect(f.service.snapshot()).toMatchObject({qwenGgufConfigured:false,ggufRuntimeSetup:{busy:false,application:'deferred'}});expect(f.models.verify).not.toHaveBeenCalled();expect(f.make).not.toHaveBeenCalled()
})
it('coalesces cancel and drains the setup owner before permitting new work or any late connection',async()=>{
 const f=await fixture(),g=gate(),cancelDone=gate();await f.selectQwen();f.installer.install.mockImplementation(async id=>{await g.promise;return f.connections[id]});f.installer.cancel.mockImplementation(async()=>{await cancelDone.promise;g.resolve()})
 const pending=f.service.setupGgufRuntime('qwen-cuda','install');await vi.waitFor(()=>expect(f.installer.install).toHaveBeenCalled());const first=f.service.cancelInstallGgufRuntime(),second=f.service.cancelInstallGgufRuntime();expect(first).toBe(second)
 expect(f.service.snapshot().ggufRuntimeSetup).toMatchObject({busy:true,cancelling:true});await expect(f.service.prepare(true)).rejects.toThrow('GGUF_RUNTIME_BUSY');await expect(f.service.setupGgufRuntime('qwen-vulkan','install')).rejects.toThrow('GGUF_RUNTIME_BUSY')
 cancelDone.resolve();await Promise.all([first,pending]);expect(f.installer.cancel).toHaveBeenCalledOnce();expect(f.service.snapshot()).toMatchObject({qwenGgufConfigured:false,ggufRuntimeSetup:{busy:false,cancelling:false}});expect(f.make).not.toHaveBeenCalled()
})
it('unloads the active owned runtime before repairing shared dependencies',async()=>{
 const f=await fixture();await f.service.executionProfile('gguf-cuda-f16');await f.service.configureVoxPublicGguf(f.python,f.voxModel,{runtimeDir:f.connections['vox-cuda'].runtimeDir,derivativeDir:f.voxModel,receipt:f.connections['vox-cuda'].receipt!});await f.service.enabled(true);await f.service.prepare(true);const runtime=f.runtimes[0];expect(runtime.running).toBe(true)
 f.installer.repair.mockImplementation(async id=>{expect(runtime.running).toBe(false);return f.connections[id]});await f.service.setupGgufRuntime('vox-cuda','repair');expect(runtime.stop).toHaveBeenCalled();expect(f.service.snapshot()).toMatchObject({enabled:true,status:'unavailable',ggufRuntimeSetup:{application:'connected'}})
})
it('preserves both complete Qwen connections across a manual override and settings reload',async()=>{
 const f=await fixture();await f.selectQwen();await f.service.setupGgufRuntime('qwen-cuda','install');const cuda=(await f.saved()).qwenGgufBackends.cuda
 await f.service.executionProfile('qwen-gguf-vulkan');await f.service.setupGgufRuntime('qwen-vulkan','install');await f.service.configureQwenGguf('/manual-python.exe','/manual-model','/manual-vulkan')
 await f.service.executionProfile('qwen-gguf');expect((f.service as any).qwenConnection()).toEqual(cuda);await f.service.close();const reopened=f.create();await reopened.initialize();expect((reopened as any).qwenConnection()).toEqual(cuda)
 await reopened.executionProfile('qwen-gguf-vulkan');expect((reopened as any).qwenConnection()).toEqual({python:'/manual-python.exe',model:'/manual-model',ggufRuntime:'/manual-vulkan'})
})
it('preserves the other public Vox backend across manual reconnect and reload',async()=>{
 const f=await fixture();await f.service.executionProfile('gguf-cuda-f16');await f.service.setupGgufRuntime('vox-cuda','install');const cuda=(await f.saved()).voxPublicGgufBackends.cuda
 await f.service.executionProfile('gguf-vulkan-f16');await f.service.setupGgufRuntime('vox-vulkan','install');await f.service.configureVoxPublicGguf('/manual-python.exe','/manual-model',{runtimeDir:'/manual-vulkan',derivativeDir:'/manual-model',receipt:'/manual.json'})
 await f.service.executionProfile('gguf-cuda-f16');expect((f.service as any).voxGgufConnection()).toEqual(cuda);await f.service.close();const reopened=f.create();await reopened.initialize();expect((reopened as any).voxGgufConnection()).toEqual(cuda)
 await reopened.executionProfile('gguf-vulkan-f16');expect((reopened as any).voxGgufConnection().python).toBe('/manual-python.exe')
})
it('preserves trained Vox CUDA and Vulkan connections without replacing original weights or derivatives with the public model',async()=>{
 const f=await fixture(),trained={id:'trained-fixture',version:'1',name:'Fixture trained voice',fingerprint:'c'.repeat(64),adapterSha256:'d'.repeat(64)},original=join(f.root,'owned-original'),derivative=join(f.root,'owned-derivative')
 // Register only synthetic metadata; no real pack, model or converter is used.
 ;(f.service as any).state.profiles.push(trained);await f.service.bind('gpichan','trained-fixture@1');await f.service.executionProfile('gguf-cuda-f16')
 await f.service.configureVoxGguf('/manual/python.exe',original,{runtimeDir:'/manual/native',derivativeDir:derivative,receipt:'/manual/receipt.json'})
 await f.service.setupGgufRuntime('vox-cuda','install');const cuda=structuredClone((f.service as any).voxGgufConnection())
 await f.service.executionProfile('gguf-vulkan-f16');await f.service.setupGgufRuntime('vox-vulkan','install');const vulkan=structuredClone((f.service as any).voxGgufConnection())
 expect(cuda.gguf.derivativeDir).toBe(derivative);expect(vulkan.model).toBe(original);expect(f.models.verify).not.toHaveBeenCalled()
 await f.service.executionProfile('gguf-cuda-f16');expect((f.service as any).voxGgufConnection()).toEqual(cuda)
 await f.service.close();const reopened=f.create();await reopened.initialize();(reopened as any).state.profiles.push(trained);await reopened.bind('gpichan','trained-fixture@1')
 await reopened.executionProfile('gguf-cuda-f16');expect((reopened as any).voxGgufConnection()).toEqual(cuda)
 await reopened.executionProfile('gguf-vulkan-f16');expect((reopened as any).voxGgufConnection()).toEqual(vulkan)
 await reopened.configureVoxGguf('/manual-new/python.exe',original,{runtimeDir:'/manual-new/vulkan',derivativeDir:derivative,receipt:'/manual-new/receipt.json'})
 await reopened.executionProfile('gguf-cuda-f16');expect((reopened as any).voxGgufConnection()).toEqual(cuda)
})
it('uses the managed portable prefix without a venv config and detects dependency changes for warm identity',async()=>{
 const f=await fixture();await f.selectQwen();await f.service.setupGgufRuntime('qwen-cuda','install');const before=await(f.service as any).qwenAssets(reference);await writeFile(join(f.dependency,'fixture.dll'),'changed fixture bytes');expect(await(f.service as any).qwenAssets(reference)).not.toBe(before)
 expect(before).toMatch(/^[a-f0-9]{64}$/);await f.service.enabled(true);await f.service.prepare(true);expect(f.installer.verify).toHaveBeenCalledWith('qwen-cuda');expect(f.runtimes[0].config).toHaveProperty('beforeManagedSpawn')
 f.installer.verify.mockResolvedValue({...f.connections['qwen-cuda'],python:'/unexpected/python.exe'});await expect(f.runtimes[0].config.beforeManagedSpawn()).rejects.toThrow('GGUF_RUNTIME_CHANGED')
})
it('does not send the component inventory or provenance in progress snapshots',async()=>{
 const f=await fixture();const text=JSON.stringify(f.service.snapshot());expect(text.length).toBeLessThan(20000);expect(text).not.toContain('largeNeverSent');expect(text).not.toContain('private-file');expect(f.service.snapshot().ggufRuntimeCatalog?.runtimes).toHaveLength(4)
})
it.each(['refresh','preview'] as const)('metadata %s cannot interrupt a pending managed preparation admission',async action=>{
 const f=await fixture(),verification=gate();await f.selectQwen();await f.service.setupGgufRuntime('qwen-cuda','install');await f.service.enabled(true)
 f.installer.verify.mockImplementation(async()=>{await verification.promise;return f.connections['qwen-cuda']})
 const preparing=f.service.prepare(true);await vi.waitFor(()=>expect(f.installer.verify).toHaveBeenCalledOnce())
 const listing=action==='refresh'?f.service.refreshManagedModels():f.service.inspectManagedModelRemoval('qwen3-tts-06b-gguf')
 await expect(listing).rejects.toThrow('VOICE_MODEL_REMOVAL_BUSY');expect(f.models.modelRemoval).not.toHaveBeenCalled();expect(f.installer.cancel).not.toHaveBeenCalled()
 verification.resolve();await preparing
 expect(f.service.snapshot()).toMatchObject({status:'idle',error:null,engineReady:true});expect(f.runtimes[0].running).toBe(true)
})
it.each(['refresh','preview'] as const)('metadata %s cannot enter the retired speech cancellation handoff',async action=>{
 const f=await fixture(),cancellation=gate(),owner=f.service as any
 await f.selectQwen();await f.service.setupGgufRuntime('qwen-cuda','install');await f.service.enabled(true);await f.service.prepare(true)
 const runtime=f.runtimes[0];runtime.busy=true;owner.currentSpeech=()=>true
 runtime.cancelSpeech.mockImplementation(async()=>{await cancellation.promise;runtime.running=false;runtime.busy=false;return {}})
 runtime.stream=vi.fn(async(_text:string,_binding:unknown,_index:number,accept:any)=>{await accept({audioId:'handoff-chunk',bytes:new Uint8Array(20),durationMs:1,generationMs:1,rtf:1,synthesisId:'handoff',chunkIndex:0,sampleOffset:0,sampleCount:1,firstChunkReadyMs:1});return{totalChunks:1,totalSamples:1}})
 owner.event=(event:any)=>{if(event.type==='audio')queueMicrotask(()=>{f.service.audio(event.audioId,event.epoch);f.service.played(event.audioId,event.epoch)})}
 f.service.setOutputReady(true,false)
 const message={id:'handoff',role:'assistant',status:'complete',text:'응.',createdAt:'fixture',binding:{characterId:'gpichan',revision:'1',conversationId:'',personaHash:'fixture',semanticHash:'fixture',requestId:'fixture'}}
 const reading=owner.read(message,true);await vi.waitFor(()=>expect(runtime.cancelSpeech).toHaveBeenCalledOnce())
 expect(owner.currentSpeech).toBeNull();expect(owner.preparing).toBeNull()
 await expect(action==='refresh'?f.service.refreshManagedModels():f.service.inspectManagedModelRemoval('qwen3-tts-06b-gguf')).rejects.toThrow('VOICE_MODEL_REMOVAL_BUSY')
 expect(f.models.modelRemoval).not.toHaveBeenCalled();expect(f.installer.cancel).not.toHaveBeenCalled()
 cancellation.resolve();await reading
 expect(runtime.stream).toHaveBeenCalledOnce();expect(runtime.start).toHaveBeenCalledTimes(2)
 expect(f.service.snapshot()).toMatchObject({status:'idle',error:null,engineReady:true})
})
it.each(['prepare','checkModel'] as const)('cancels an internal managed %s admission without marking verified model files damaged',async owner=>{
 const f=await fixture();await f.selectQwen();await f.service.setupGgufRuntime('qwen-cuda','install');await f.service.enabled(true)
 let entered!:()=>void,reject!: (error:Error)=>void
 const admitting=new Promise<void>(resolve=>entered=resolve),verification=new Promise<GgufRuntimeConnection>((_resolve,fail)=>reject=fail)
 f.installer.verify.mockImplementation(async()=>{entered();return verification})
 f.installer.cancel.mockImplementation(async()=>{reject(Object.assign(Error('fixture cancellation'),{name:'AbortError'}))})
 const pending=owner==='prepare'?f.service.prepare(true):f.service.checkModel();await admitting
 await f.service.cancelInstallGgufRuntime();await pending
 expect(f.service.snapshot()).toMatchObject({status:'stopped',error:null});expect(f.service.snapshot().modelCheck?.error??null).toBeNull();expect((f.service as any).blockedModels.size).toBe(0)
 expect(f.runtimes.every(runtime=>!runtime.running)).toBe(true)
})

it('one files action installs the chosen model then connects its verified runtime without speech',async()=>{
 const f=await fixture(false);await f.selectQwen();await f.service.prepareVoiceFiles()
 expect(f.models.install).toHaveBeenCalledWith('qwen3-tts-06b-gguf');expect(f.installer.install).toHaveBeenCalledWith('qwen-cuda')
 expect(f.service.snapshot()).toMatchObject({enabled:false,qwenGgufConfigured:true,runtimeConfigured:true,filePreparation:{busy:false,id:'qwen-cuda',phase:'connected',error:null}})
 expect(f.make).not.toHaveBeenCalled()
})
it('unpublished runtime blocks combined preparation before any model download',async()=>{
 const f=await fixture(false);await f.selectQwen();const snapshot=f.installer.snapshot
 f.installer.snapshot=()=>snapshot().map(s=>({...s,available:false,blockedReason:'GGUF_RUNTIME_ARTIFACT_PENDING'}))
 expect(()=>f.service.prepareVoiceFiles()).toThrow('GGUF_RUNTIME_ARTIFACT_PENDING');expect(f.models.install).not.toHaveBeenCalled();expect(f.installer.install).not.toHaveBeenCalled()
})
it.each(['cancel','context','engine'] as const)('model-stage %s prevents the next runtime stage and any late connection',async reason=>{
 const f=await fixture(false),g=gate();await f.selectQwen();let current=true;const original=f.models.install.getMockImplementation()!
 f.models.install.mockImplementation(async id=>{await g.promise;return original(id)});f.models.cancel.mockImplementation(async()=>{g.resolve()})
 const preparing=f.service.prepareVoiceFiles(()=>current);await vi.waitFor(()=>expect(f.models.install).toHaveBeenCalledOnce())
 if(reason==='cancel')await f.service.cancelPrepareVoiceFiles();else{if(reason==='context')current=false;else await f.service.selectVoicePath('vox-gguf');g.resolve()}
 await preparing;expect(f.installer.install).not.toHaveBeenCalled();expect(f.service.snapshot().qwenGgufConfigured).toBe(false);expect(f.make).not.toHaveBeenCalled()
 expect(f.service.snapshot().filePreparation).toMatchObject({busy:false,phase:reason==='cancel'?'cancelled':'deferred'})
})
it('a failed model stage preserves a retry route and never starts its runtime',async()=>{
 const f=await fixture(false);await f.selectQwen();f.models.install.mockRejectedValueOnce(Error('VOICE_DOWNLOAD_FAILED'))
 await expect(f.service.prepareVoiceFiles()).rejects.toThrow('VOICE_DOWNLOAD_FAILED');expect(f.installer.install).not.toHaveBeenCalled()
 expect(f.service.snapshot().filePreparation).toMatchObject({busy:false,phase:'error',error:'VOICE_DOWNLOAD_FAILED'})
 await f.service.prepareVoiceFiles();expect(f.service.snapshot().filePreparation?.phase).toBe('connected');expect(f.make).not.toHaveBeenCalled()
})
it.each(['cancel','close'] as const)('runtime-stage %s drains the chain and prevents late application',async boundary=>{
 const f=await fixture(false),g=gate();await f.selectQwen();const original=f.installer.install.getMockImplementation()!
 f.installer.install.mockImplementation(async id=>{await g.promise;return original(id)})
 f.installer.cancel.mockImplementation(async()=>{g.resolve()})
 const preparing=f.service.prepareVoiceFiles();await vi.waitFor(()=>expect(f.installer.install).toHaveBeenCalledOnce())
 await (boundary==='close'?f.service.close():f.service.cancelPrepareVoiceFiles());await preparing
 expect(f.service.snapshot()).toMatchObject({qwenGgufConfigured:false,filePreparation:{busy:false,phase:'cancelled'}})
 expect(f.make).not.toHaveBeenCalled()
})

async function requireTerms(f:Awaited<ReturnType<typeof fixture>>){
 f.catalog.components.shared.files=Object.assign({},...termsPolicy.groups.map(group=>group.files))
 const terms=new ManagedRuntimeTerms(f.root,resolve('electron/voice/runtime-terms'),f.catalog)
 f.service.attachManagedRuntimeTerms(terms);await terms.initialize();return terms
}
it('does not auto-accept an existing user or install any files before explicit Microsoft acceptance',async()=>{
 const f=await fixture();await f.selectQwen();await f.service.setupGgufRuntime('qwen-cuda','install');await f.service.enabled(true);const settings=await f.saved();f.installer.install.mockClear();f.models.install.mockClear();f.installer.verify.mockClear()
 const terms=await requireTerms(f);expect(f.service.snapshot()).toMatchObject({ggufRuntimeTerms:{accepted:false},status:'unavailable',error:'GGUF_RUNTIME_TERMS_REQUIRED'})
 expect(()=>f.service.prepareVoiceFiles()).toThrow('GGUF_RUNTIME_TERMS_REQUIRED')
 await expect(f.service.setupGgufRuntime('qwen-cuda','install')).rejects.toThrow('GGUF_RUNTIME_TERMS_REQUIRED')
 await f.service.prepare();await expect(f.service.prepare(true)).rejects.toThrow('GGUF_RUNTIME_TERMS_REQUIRED');await expect(f.service.checkModel()).rejects.toThrow('GGUF_RUNTIME_TERMS_REQUIRED')
 expect(f.installer.install).not.toHaveBeenCalled();expect(f.installer.verify).not.toHaveBeenCalled();expect(f.models.install).not.toHaveBeenCalled();expect(f.make).not.toHaveBeenCalled();expect(await f.saved()).toEqual(settings)
 await expect(f.service.acceptManagedRuntimeTerms(terms.fingerprint,()=>false)).rejects.toThrow('CHAT_SETTINGS_EXPIRED');expect(f.service.snapshot().ggufRuntimeTerms?.accepted).toBe(false)
})
it('keeps model-only actions usable, then verifies existing files and connects with one preparation action after acceptance',async()=>{
 const f=await fixture();await f.selectQwen();const terms=await requireTerms(f),settings=await f.saved()
 await f.service.installGgufModel('qwen3-tts-06b-gguf');await f.service.verifyGgufModel('qwen3-tts-06b-gguf');expect(f.service.snapshot().ggufRuntimeTerms?.accepted).toBe(false);expect(f.installer.install).not.toHaveBeenCalled()
 await f.service.acceptManagedRuntimeTerms(terms.fingerprint);expect(await f.saved()).toEqual(settings);expect(f.make).not.toHaveBeenCalled()
 await f.service.prepareVoiceFiles();expect(f.service.snapshot()).toMatchObject({ggufRuntimeTerms:{accepted:true},filePreparation:{phase:'connected',busy:false},qwenGgufConfigured:true,enabled:false});expect(f.make).not.toHaveBeenCalled()
 await f.service.enabled(true);await f.service.prepare(true);expect(f.runtimes[0].running).toBe(true)
 await f.service.close();const reopened=f.create(),fresh=new ManagedRuntimeTerms(f.root,resolve('electron/voice/runtime-terms'),f.catalog);reopened.attachManagedRuntimeTerms(fresh);await reopened.initialize();expect(reopened.snapshot().ggufRuntimeTerms?.accepted).toBe(true)
})
it('fails closed at the worker admission point when no terms provider can be initialized',async()=>{
 const f=await fixture();await f.selectQwen();await f.service.setupGgufRuntime('qwen-cuda','install');await f.service.enabled(true);await f.service.prepare(true);const admission=f.runtimes[0].config.beforeManagedSpawn
 f.service.requireManagedRuntimeTerms();await expect(admission()).rejects.toThrow('GGUF_RUNTIME_TERMS_CHANGED')
})
it.each(['qwen3-tts-06b','voxcpm2'] as const)('gates managed-prefix interpreters even through the manual %s engine without a managed marker',async engine=>{
 const f=await fixture();await f.selectQwen();const python=join(f.root,'rt','fixture','python.exe');await mkdir(dirname(python),{recursive:true});await writeFile(python,'inert fixture only; never executed')
 await f.service.engine(engine)
 if(engine==='qwen3-tts-06b')await f.service.configureQwen(python,f.qwenModel)
 else{const trained={id:'trained-fixture',version:'1',name:'Fixture',fingerprint:'d'.repeat(64),adapterSha256:'e'.repeat(64)};(f.service as any).state.profiles.push(trained);await f.service.bind('gpichan','trained-fixture@1');await f.service.executionProfile('compiled');await f.service.configure(python,f.voxModel)}
 f.service.requireManagedRuntimeTerms();await f.service.enabled(true)
 await expect(f.service.prepare(true)).rejects.toThrow('GGUF_RUNTIME_TERMS_CHANGED');await expect(f.service.checkModel()).rejects.toThrow('GGUF_RUNTIME_TERMS_CHANGED');expect(f.make).not.toHaveBeenCalled()
 const terms=await requireTerms(f);await expect(f.service.prepare(true)).rejects.toThrow('GGUF_RUNTIME_TERMS_REQUIRED');expect(f.make).not.toHaveBeenCalled();expect(terms.snapshot('qwen-cuda').accepted).toBe(false)
})
it('blocks an old marker-less GGUF manual connection under the managed prefix when catalog attachment fails',async()=>{
 const f=await fixture();await f.selectQwen();const python=join(f.root,'rt','fixture','python.exe');await mkdir(dirname(python),{recursive:true});await writeFile(python,'inert fixture only')
 await f.service.configureQwenGguf(python,f.qwenModel,f.connections['qwen-cuda'].runtimeDir);f.service.requireManagedRuntimeTerms();await f.service.enabled(true)
 await f.service.prepare();await expect(f.service.prepare(true)).rejects.toThrow('GGUF_RUNTIME_TERMS_CHANGED');await expect(f.service.checkModel()).rejects.toThrow('GGUF_RUNTIME_TERMS_CHANGED');expect(f.make).not.toHaveBeenCalled()
})
