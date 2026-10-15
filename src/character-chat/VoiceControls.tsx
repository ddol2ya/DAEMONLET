import type {GpuBackendPreference} from '../../electron/shared/gpu-backend'
import {ManagedRuntimeTerms} from './ManagedRuntimeTerms'
import {VoiceEngineStep,VoiceSetupStep} from './VoiceSetupFlow'
import {isLegacyVoiceModel,voiceSetupPlatform} from '../../electron/shared/voice-setup-paths'
import {DEFAULT_VOICE_SEED,validVoiceSeed} from '../../electron/shared/voice-seed'
import {useT} from '../i18n/useLanguage'
import {useEffect,useState} from 'react'
import {GGUF_MODEL_CATALOG,isManagedVoice,isQwenEngine,isReferenceProfile,isStreamingProfile,isWindowsVoxGgufProfile,type VoiceAction,type VoiceApi,type VoiceSnapshot,type ExecutionProfile,type GgufRuntimeId,VoiceEngine} from '../../electron/shared/character-voice-contract'
import {AudioPlaybackController} from './AudioPlaybackController'
declare global{interface Window{characterVoice:VoiceApi}}
const statuses={unavailable:'음성 준비 필요',off:'음성 꺼짐',idle:'준비됨',loading:'음성 모델 준비 중',synthesizing:'발화 합성 중',playing:'음성 재생 중',stopped:'음성 중단됨',error:'음성 오류 · 텍스트 대화는 계속 사용할 수 있어요'}
const errors:Record<string,string>={VOICE_GPU_UNAVAILABLE:'음성 GPU를 확인하지 못했습니다. 실행 방식을 직접 선택하거나 그래픽 드라이버를 확인해 주세요.',QWEN_INSTALL_UNSUPPORTED:'이 장치에서는 Qwen 설치를 지원하지 않습니다.',QWEN_INSTALL_CHANGED:'Qwen 설치 파일 검증에 실패했습니다. 복구 설치를 실행해 주세요.',QWEN_RUNTIME_INSTALL:'Qwen 실행 환경을 준비하지 못했습니다. 다시 시도하면 검증된 다운로드를 재사용합니다.',QWEN_ARCHIVE_PATH:'Qwen 설치 압축 파일의 경로 검증에 실패했습니다.',QWEN_ARCHIVE_INVALID:'Qwen 설치 압축 파일이 올바르지 않습니다.',QWEN_ARCHIVE_LIMIT:'Qwen 설치 압축 파일의 크기 제한을 초과했습니다.',VOICE_PREPARATION_UNAVAILABLE:'선택한 캐릭터의 음성 엔진, 기준 음성과 실행 모드를 확인해 주세요.',VOICE_PRESENTATION_PREPARATION_TIMEOUT:'음성 준비 시간이 초과됐어요. 음성 설정을 확인하고 다시 시도해 주세요.',VOICE_TIMEOUT:'음성 엔진 응답 시간이 초과됐어요. 준비 상태를 확인한 뒤 다시 시도해 주세요.',VOICE_CANCEL_TIMEOUT:'음성 중단을 완료하지 못했어요. 엔진 정리를 확인해 주세요.',VOICE_PLAYBACK_TIMEOUT:'오디오 재생 확인 시간이 초과됐어요. 재생 장치를 확인해 주세요.',VOICE_PRESENTATION_FAILED:'음성을 준비하거나 재생하지 못했어요. 음성 설정을 확인해 주세요.',VOICE_MODEL_CHECK_FAILED:'모델 전체 검사에 실패했습니다. 원본 모델을 다시 연결하거나 설치를 복구해 주세요.',QWEN_REFERENCE_REQUIRED:'Qwen에는 사용 권한이 있는 WAV 음성을 직접 선택해 주세요.',QWEN_RUNTIME_MISSING:'Qwen 전용 Python과 고정 로컬 모델을 연결해 주세요.',QWEN_TRANSCRIPT_REQUIRED:'ICL에는 기준 WAV에서 실제로 말한 정확한 문장이 필요합니다.',QWEN_WORKER_ERROR:'Qwen 합성에 실패했습니다. 격리 환경의 설치 상태를 확인해 주세요.',QWEN_RUNTIME_RECEIPT:'Qwen 전용 설치 영수증을 확인할 수 없습니다.',QWEN_MODEL_CHANGED:'고정 Qwen 모델의 파일 검증에 실패했습니다.',VOICE_SEED_SETTINGS:'저장된 시드 설정이 손상됐습니다. 시드 설정을 다시 적용해 주세요.',VOICE_SEED_INVALID:'시드는 1부터 2147483647 사이의 정수여야 합니다.',VOICE_SEED_UNSUPPORTED:'이 음성 엔진은 요청별 시드를 지원하지 않습니다. 새 후보 엔진을 연결해 주세요.',VOICE_SEED_MISMATCH:'음성 엔진이 요청과 다른 시드를 적용했습니다.',VOICE_REPLAY_MISSING:'보관된 음성이 없습니다. 재합성 동작을 선택해 주세요.',VOICE_REPRODUCE_CHANGED:'생성 조건이 바뀌었습니다. 현재 설정으로 다시 합성해 주세요.',VOICE_REFERENCE_NAME:'음성 이름을 1~80자로 입력하고 사용 권한을 확인해 주세요.',VOICE_REFERENCE_FORMAT:'올바른 RIFF/WAVE 파일을 선택해 주세요.',VOICE_REFERENCE_UNSUPPORTED:'PCM 16·24비트 또는 float32, 모노·스테레오 WAV를 지원합니다.',VOICE_REFERENCE_SIZE:'WAV 파일은 20MiB 이하여야 합니다.',VOICE_REFERENCE_DURATION:'기준 음성은 2~20초여야 합니다.',VOICE_REFERENCE_SAMPLES:'WAV에 올바르지 않은 샘플 값이 있습니다.',VOICE_REFERENCE_SILENT:'음성이 너무 작거나 무음입니다. 또렷한 발화를 선택해 주세요.',VOICE_REFERENCE_COUNT:'WAV 음성은 최대 32개까지 저장할 수 있습니다.',VOICE_REFERENCE_STORAGE_LIMIT:'WAV 음성 저장 공간 한도를 초과했습니다.',VOICE_REFERENCE_FILE:'링크가 아닌 일반 WAV 파일을 선택해 주세요.',VOICE_REFERENCE_IMPORT:'WAV를 가져오지 못했습니다. 파일을 확인하고 다시 시도해 주세요.',VOICE_REFERENCE_TIMEOUT:'WAV 처리 시간이 초과됐습니다.',VOICE_REFERENCE_STORAGE:'WAV 음성 저장소를 확인할 수 없습니다. 다른 음성은 계속 사용할 수 있습니다.',VOICE_REFERENCE_CHANGED:'저장된 기준 음성 검증에 실패했습니다. 원본 WAV를 새 프로필로 가져와 주세요.',VOICE_REFERENCE_UNAVAILABLE:'선택한 WAV 음성이 없거나 손상됐습니다. 다른 음성을 직접 선택하거나 원본을 다시 가져와 주세요.',VOICE_REFERENCE_RUNTIME:'이 음성 엔진은 WAV 클로닝 계약을 지원하지 않습니다.',VOICE_REFERENCE_BINDING:'음성 조건이 바뀌었습니다. 다시 재생해 주세요.',VOICE_RUNTIME_INSTALL:'음성 실행 환경 설치를 완료하지 못했습니다. 다시 시도하면 내려받은 파일을 재사용합니다.',VOICE_BASE_NOT_INSTALLED:'기본 음성 설치 버튼으로 모델을 먼저 받아 주세요.',VOICE_BASE_RUNTIME:'이 앱의 기본 음성 엔진을 확인하지 못했습니다. 기본 음성을 포함한 Mac 배포본이 필요합니다.',VOICE_BASE_CHANGED:'기본 음성 파일 검증에 실패했습니다. 설치 버튼으로 다시 받아 주세요.',VOICE_DOWNLOAD_FAILED:'다운로드하지 못했습니다. 설치 버튼을 다시 누르면 이어받습니다.',VOICE_DOWNLOAD_ACCESS:'모델 제공처의 접근 조건을 확인해 주세요.',VOICE_DOWNLOAD_RANGE:'서버의 이어받기 응답이 올바르지 않습니다. 다시 시도해 주세요.',VOICE_DISK_SPACE:'기본 음성 설치를 위한 여유 공간이 부족합니다.',GGUF_CONVERSION_FAILED:'실행용 음성을 준비하지 못했습니다. 호환되는 LoRA 패키지와 변환 환경을 확인해 주세요.',GGUF_CACHE_CHANGED:'저장된 실행용 음성의 검증에 실패했습니다. 해당 음성을 삭제하고 원본 패키지를 다시 가져와 주세요.',GGUF_DISK_SPACE:'첫 음성 준비에는 임시 여유 공간 30GB가 필요합니다.',RUNTIME_DEPENDENCY:'음성 런타임의 추론 패키지를 찾거나 불러올 수 없습니다. 설치 진단을 실행해 주세요.',MPS_OOM:'Mac GPU 메모리가 부족합니다. 다른 GPU 작업이 끝난 뒤 다시 시도해 주세요.',VOICE_PLATFORM_PROFILE:'다른 플랫폼의 음성 설정입니다. 이 Mac에 맞는 실행 모드와 런타임을 연결한 뒤 음성을 켜 주세요.',RUNTIME_POLICY:'선택한 음성 실행 모드와 환경이 다릅니다.',RUNTIME_VERSION:'선택한 Python이 승인된 음성 런타임 버전과 다릅니다.',RUNTIME_RECEIPT:'Mac 음성 런타임의 설치 영수증을 확인하지 못했습니다.',VOICE_CLEANUP_PENDING:'음성 연결은 해제됐지만 파일 정리가 남아 있습니다. 앱을 다시 시작하면 정리를 재시도합니다.',VOICE_NOT_INSTALLED:'음성 패키지를 가져온 뒤 캐릭터 음성을 선택해 주세요.',VOICE_RUNTIME_MISSING:'독립 TTS Python과 로컬 모델을 연결해 주세요.',VOICE_WORKER_START:'음성 엔진을 시작하지 못했습니다. 설치 상태와 실행 환경을 확인해 주세요.',VOICE_PLAYBACK:'오디오 출력을 시작하지 못했습니다. 시험 재생을 다시 눌러 주세요.',CUDA_OOM:'GPU 메모리가 부족합니다. 음성을 끄거나 다른 GPU 작업이 끝난 뒤 다시 시도해 주세요.',VOICE_SELECTION_MISMATCH:'선택된 6000개 학습 채택본과 패키지 해시가 다릅니다.',UNSUPPORTED_DEVICE:'이 장치에서는 음성을 지원하지 않습니다. Windows CUDA 또는 Apple Silicon Metal 환경이 필요합니다.'}
Object.assign(errors,{
 QWEN_GGUF_RUNTIME_MISSING:'Qwen GGUF 전용 Python, 검증된 CUDA DLL과 Base Q8·codec Q8 모델 폴더를 연결해 주세요.',
 QWEN_GGUF_UNSUPPORTED:'Qwen GGUF에는 Windows x64와 지원되는 NVIDIA CUDA 환경이 필요합니다.',
 QWEN_GGUF_RUNTIME_CHANGED:'Qwen GGUF 실행 파일 검증에 실패했습니다. 검증된 런타임 폴더를 다시 연결해 주세요.',
 QWEN_GGUF_MODEL_CHANGED:'고정 Qwen 0.6B Base Q8·codec Q8 모델 파일 검증에 실패했습니다.',
 QWEN_GGUF_ABI:'Qwen GGUF 런타임 버전이 맞지 않습니다. 검증된 CUDA DLL 폴더를 연결해 주세요.',
 QWEN_GGUF_BACKEND:'Qwen GGUF의 CUDA 실행을 확인하지 못했습니다. NVIDIA GPU와 CUDA 환경을 확인해 주세요.',
 QWEN_GGUF_WORKER_ERROR:'Qwen GGUF 합성에 실패했습니다. 런타임·모델 연결과 기준 WAV를 확인해 주세요.'
})
Object.assign(errors,{
 QWEN_GGUF_ASSET_CHANGED:'Qwen GGUF 파일 검증에 실패했습니다. 검증된 Python·DLL·모델 폴더를 다시 연결해 주세요.',
 QWEN_GGUF_RUNTIME_VERSION:'Qwen GGUF Python 패키지 버전이 맞지 않습니다. 검증된 전용 환경을 연결해 주세요.',
 QWEN_GGUF_BASE_REQUIRED:'Qwen GGUF에는 고정 0.6B Base Q8 모델이 필요합니다. CustomVoice 모델은 사용할 수 없습니다.',
 QWEN_GGUF_PLATFORM_REQUIRED:errors.QWEN_GGUF_UNSUPPORTED,
 QWEN_GGUF_CUDA_REQUIRED:errors.QWEN_GGUF_BACKEND,
 QWEN_GGUF_REFERENCE_PREP:errors.QWEN_GGUF_WORKER_ERROR,
 QWEN_GGUF_SYNTHESIS:errors.QWEN_GGUF_WORKER_ERROR,
 QWEN_GGUF_RUNTIME_CONFIG:errors.QWEN_GGUF_RUNTIME_MISSING,
 QWEN_GGUF_CAPABILITIES:errors.QWEN_GGUF_ABI
})
Object.assign(errors,{
 VOX_GGUF_UNSUPPORTED:'VoxCPM2 Windows GGUF에는 Windows x64 실행 환경이 필요합니다.',
 VOX_GGUF_RUNTIME_MISSING:'VoxCPM2 GGUF 전용 Python, 원본 모델, 실행 환경, F16 파생 모델과 승인 기록을 연결해 주세요.',
 VOX_GGUF_BUILD_PENDING:'선택한 VoxCPM2 GGUF 실행 환경의 검증이 완료되지 않았습니다. 검증된 실행 파일과 승인 기록을 연결해 주세요.',
 VOX_GGUF_DERIVATIVE_UNSUPPORTED:'선택한 학습팩에 대응하는 검증된 F16 GGUF가 없습니다. 호환성이 확인된 학습팩과 변환 결과를 함께 연결해 주세요.',
 VOX_GGUF_NATIVE_INIT:'VoxCPM2 GGUF 실행기를 준비하지 못했습니다. 고정 F16 모델, EXE·DLL과 GPU 실행 환경을 확인해 주세요.',
 VOX_GGUF_WORKER_ERROR:'VoxCPM2 GGUF 합성에 실패했습니다. 학습팩, 파생 모델과 실행 환경의 연결을 확인해 주세요.'
})
Object.assign(errors,{
 QWEN_GGUF_BACKEND_UNAPPROVED:'선택한 Qwen GGUF 실행 모드의 DLL 검증이 완료되지 않았습니다. 검증된 실행 환경을 연결해 주세요.',
 QWEN_GGUF_VULKAN_REQUIRED:'Qwen GGUF Vulkan 실행을 확인하지 못했습니다. Vulkan GPU 실행 환경과 DLL 폴더를 확인해 주세요.',
 QWEN_GGUF_GPU_REQUIRED:'Qwen GGUF에서 선택한 GPU 실행을 확인하지 못했습니다. 실행 모드에 맞는 GPU와 DLL 폴더를 확인해 주세요.',
 VOX_GGUF_PUBLIC_MODEL_CHANGED:'공개 VoxCPM2 F16 GGUF 모델 검증에 실패했습니다. 고정 공개 모델 파일을 다시 연결하거나 다운로드해 주세요.',
 VOX_GGUF_MODEL_KIND:'선택한 음성과 GGUF 모델 종류가 다릅니다. 학습팩에는 해당 팩의 변환 결과를, 기본·WAV 음성에는 공개 F16 모델을 연결해 주세요.',
 VOX_GGUF_BASE_NATIVE_PENDING:'VoxCPM2 GGUF 기본 음성 실행기가 아직 검증되지 않았습니다. WAV 기준 음성 또는 검증된 학습팩을 사용해 주세요.',
 VOX_GGUF_PLATFORM:errors.VOX_GGUF_UNSUPPORTED,
 VOX_GGUF_TRAINED_REQUIRED:'VoxCPM2 GGUF를 준비하려면 학습 음성팩을 가져온 뒤 캐릭터에 선택해 주세요.',
 VOX_GGUF_ASSET_CHANGED:'VoxCPM2 GGUF 연결 파일의 검증 결과가 바뀌었습니다. 학습팩·원본 모델·파생 모델·실행 환경을 다시 확인해 주세요.'
})
const voxGgufErrors:Record<string,string>={
 RUNTIME_RECEIPT:'VoxCPM2 GGUF 실행 환경과 승인 기록이 일치하지 않습니다. 검증된 실행 환경과 해당 승인 기록을 함께 연결해 주세요.',
 RUNTIME_SOURCE_CHANGED:'VoxCPM2 GGUF 실행 파일 검증에 실패했습니다. 검증된 EXE·DLL 폴더를 다시 연결해 주세요.',
 LORA_INCOMPLETE:'학습팩과 F16 GGUF 변환 기록이 호환되지 않습니다. 해당 학습팩을 반영한 검증된 변환 결과를 연결해 주세요.'
}
Object.assign(errors,{
 VOX_GGUF_RUNTIME_CONFIG:errors.VOX_GGUF_RUNTIME_MISSING,
 VOX_GGUF_CAPABILITIES:errors.VOX_GGUF_WORKER_ERROR,
 VOX_GGUF_TRAINED_IDENTITY:voxGgufErrors.LORA_INCOMPLETE,
 VOX_GGUF_VERIFY_FAILED:errors.VOX_GGUF_WORKER_ERROR
})
const voiceError=(state:VoiceSnapshot,error:string)=>['QWEN_GGUF_RUNTIME_MISSING','VOX_GGUF_RUNTIME_MISSING'].includes(error)&&state.ggufRuntimeInstall?.some(runtime=>runtime.id===(state.engine==='qwen3-tts-06b-gguf'?'qwen-':'vox-')+(state.executionProfile?.includes('vulkan')?'vulkan':'cuda')&&runtime.available)?'필요한 파일 받기·연결을 눌러 받은 파일을 검사하고 현재 엔진에 연결해 주세요.':!isQwenEngine(state.engine)&&isWindowsVoxGgufProfile(state.executionProfile)&&voxGgufErrors[error]||errors[error]
export function VoiceControls({showStatus=true}:{showStatus?:boolean}){
 const t=useT()
 const [state,setState]=useState<VoiceSnapshot|null>(null)
 const act=(v:VoiceAction)=>window.characterVoice.action(v).then(s=>setState(old=>old&&old.epoch>s.epoch?old:s)).catch(()=>{})
 useEffect(()=>{
  if(!window.characterVoice)return
  const player=new AudioPlaybackController(window.characterVoice,undefined,{sink:(level,epoch)=>window.characterVoice.mouth?.({level,epoch})})
  const off=window.characterVoice.subscribe(s=>{player.setVolume(s.volume);setState(old=>old&&old.epoch>s.epoch?old:s)})
  const events=window.characterVoice.onEvent(e=>void player.receive(e))
  const hide=()=>{player.setVisible(!document.hidden);void act({type:document.hidden?'stop':'ready'})}
  player.setVisible(!document.hidden)
  document.addEventListener('visibilitychange',hide)
  void window.characterVoice.action({type:'ready'}).then(s=>{player.setVolume(s.volume);setState(old=>old&&old.epoch>s.epoch?old:s)}).catch(()=>{})
  return()=>{events();off();document.removeEventListener('visibilitychange',hide);player.dispose();void window.characterVoice.action({type:'stop'}).catch(()=>{})}
 },[])
 if(!state||!showStatus)return null
 return <section className="voice-controls" aria-label={t('캐릭터 음성')}><div role="status">{t(statuses[state.status])} {state.enabled&&<button onClick={()=>void act({type:'stop'})}>{t('음성만 중단')}</button>}</div>{state.error&&<p role="alert">{t(voiceError(state,state.error)||'음성 설정을 확인해 주세요.')}</p>}</section>
}
export function VoiceSettings({state,characterId,act,playbackReady,busy=false}:{state:VoiceSnapshot;characterId?:string;act:(value:VoiceAction)=>unknown;playbackReady:boolean;busy?:boolean}){
 const t=useT(),selected=state.bindings[characterId||'']??state.defaultProfile??'',unsupported=!state.availableProfiles?.length
 const builtin=!!state.defaultProfile&&selected===state.defaultProfile,install=state.baseInstall,profile=state.profiles.find(p=>p.id+'@'+p.version===selected),reference=isReferenceProfile(profile)?profile:null,managed=builtin||!!reference||selected.startsWith('wav-')
 busy=busy||!!state.filePreparation?.busy||!!state.modelCheck?.busy||!!state.managedModelRemoval?.busy||!!state.ggufInstall?.some(model=>model.phase!=='idle')
 const qwenBusy=!!state.qwenInstall&&state.qwenInstall.phase!=='idle'
 busy=busy||qwenBusy||!!state.ggufRuntimeSetup?.busy||!!state.ggufRuntimeSetup?.cancelling||!!state.ggufRuntimeInstall?.some(runtime=>runtime.phase!=='idle')
 const qwen=isQwenEngine(state.engine),qwenGguf=state.engine==='qwen3-tts-06b-gguf',qwenConfigured=qwenGguf?state.qwenGgufConfigured:state.qwenConfigured
 const voxGguf=!qwen&&isWindowsVoxGgufProfile(state.executionProfile),trained=!!profile&&!isManagedVoice(profile),fullModelVerification=qwenGguf||voxGguf
 const preparationReason=state.ggufRuntimeTerms&&!state.ggufRuntimeTerms.accepted?'Microsoft 음성 실행 파일 이용 조건을 확인하고 직접 수락해 주세요.':busy?'다른 음성 작업이 진행 중이에요.':!characterId?'캐릭터를 먼저 선택해 주세요.':unsupported?'이 장치에서는 음성 준비를 지원하지 않아요.':!state.enabled?'음성 사용을 켠 뒤 준비할 수 있어요.':state.seedError?'음성 시드 설정을 확인해 주세요.':voxGguf&&!profile?'VoxCPM2 GGUF에는 기본 음성, WAV 기준 음성 또는 검증된 학습팩을 선택해 주세요.':!selected?'캐릭터 음성을 먼저 선택해 주세요.':qwen&&!reference?'Qwen을 준비하려면 WAV 기준 음성을 선택해 주세요.':reference?.error?'기준 음성 파일을 확인해 주세요.':voxGguf&&!state.voxGgufConfigured?(trained?'VoxCPM2 Windows GGUF 실행 환경과 해당 학습팩의 F16 파생 모델을 먼저 연결해 주세요.':'VoxCPM2 Windows GGUF 실행 환경과 공개 F16 모델을 먼저 연결해 주세요.'):!state.runtimeConfigured?'음성 엔진과 로컬 모델을 먼저 연결해 주세요.':(!isStreamingProfile(state.executionProfile)&&!state.executionProfile?.endsWith('-complete'))?'선택한 실행 모드는 미리 준비를 지원하지 않아요.':['loading','synthesizing','playing'].includes(state.status)?'음성 준비 또는 재생이 진행 중이에요.':null
 const [cloneMode,setCloneMode]=useState<'x-vector'|'icl'>(state.qwenClone?.mode||'x-vector'),[transcript,setTranscript]=useState(state.qwenClone?.transcript||'')
 useEffect(()=>{setCloneMode(state.qwenClone?.mode||'x-vector');setTranscript(state.qwenClone?.transcript||'')},[state.qwenClone?.mode,state.qwenClone?.transcript])
 const [name,setName]=useState(''),[acknowledged,setAcknowledged]=useState(false),[rename,setRename]=useState('')
 useEffect(()=>setRename(reference?.name||''),[reference?.id,reference?.name])
 return <section className="voice-settings" aria-label={t('캐릭터 음성')}>
  <div role="status">{t(statuses[state.status])}{state.enabled&&<button onClick={()=>void act({type:'stop'})}>{t('음성만 중단')}</button>}</div>
  {state.error&&<p className="notice error" role="alert">{t(voiceError(state,state.error)||'음성을 사용할 수 없습니다. 패키지·런타임·모델 위치를 확인해 다시 연결해 주세요.')}</p>}
  {unsupported&&<p id="voice-platform-support" className="notice">{t(errors.UNSUPPORTED_DEVICE)}</p>}
  <VoiceEngineStep state={state} busy={busy} act={act} legacyModels={<ManagedVoiceModels state={state} busy={busy} act={act} group="legacy"/>}/>
  {(qwenGguf||voxGguf)&&<div className="voice-gpu-settings"><label>{t('음성 GPU 실행 방식')}<select aria-label={t('음성 GPU 실행 방식')} disabled={busy} value={state.gpuBackend??(state.executionProfile?.includes('vulkan')?'vulkan':'cuda')} onChange={e=>void act({type:'gpuBackend',value:e.target.value as GpuBackendPreference})}><option value="auto">{t('자동 (권장)')}</option><option value="cuda">NVIDIA CUDA</option><option value="vulkan">Vulkan</option></select></label><small>{t('자동은 사용 가능한 CUDA를 우선 선택하고 Vulkan을 대체 경로로 사용합니다.')}</small>{state.resolvedGpuBackend&&<small role="status">{t('선택된 실행 환경')}: {state.resolvedGpuBackend==='cuda'?'NVIDIA CUDA':'Vulkan'}</small>}{state.gpuBackend==='auto'&&<small>{t('파일 준비 시 CUDA·Vulkan 실행 환경을 함께 준비합니다. 모델은 공유합니다.')}</small>}</div>}
  <VoiceSetupStep number={2} title="필요한 파일 받기·연결">
   <p>{t('이미 받은 파일은 검사 후 재사용합니다. 다운로드, 파일 검사, 연결과 모델 로딩은 각각 진행 상태를 보여줍니다.')}</p>
   <VoiceFilesPreparation state={state} busy={busy} act={act} trained={trained}/>
   <GgufModels state={state} busy={busy} act={act} model={qwenGguf?'qwen3-tts-06b-gguf':voxGguf&&!trained?'voxcpm2-gguf-f16':undefined} currentOnly/>
   <GgufRuntimeSetup state={state} busy={busy} act={act}/>
   {(qwen&&!qwenGguf||qwenBusy)&&state.qwenInstall?.supported&&<QwenInstall state={state} reference={!!reference&&!reference.error} busy={busy} act={act}/>}
   {!qwen&&!voxGguf&&install?.supported&&<div className="voice-install"><strong>{t('기본 음성 · VoxCPM2')}</strong><small>{t('학습 패키지 없이 사용할 수 있습니다.')} {t('여성 음색을 기본으로 사용하며, 문장에 따라 조금 달라질 수 있어요.')}</small><small>{t('다운로드 약')} {(install.total/1e9).toFixed(1)} GB · Apache-2.0</small>{state.availableProfiles?.includes('cuda-compiled')&&<small>{t('Python·PyTorch 실행 환경과 기본 모델을 함께 설치합니다. 여유 공간 30GB와 BF16 지원 NVIDIA GPU가 필요합니다.')}</small>}
    {install.phase!=='idle'?<><progress aria-label={t('기본 음성 설치 진행률')} value={install.bytes} max={install.total}/><span role="status">{t(install.phase==='preparing'?'설치 준비 중':install.phase==='verifying'?'파일 검증 중':install.phase==='installing'?'실행 환경 설치 중':'다운로드 중')} {install.total>0?Math.floor(install.bytes/install.total*100):0}%</span><button onClick={()=>void act({type:'cancelInstallBase'})}>{t('설치 중단')}</button></>:<button disabled={busy||install.installed} onClick={()=>void act({type:'installBase'})}>{t(install.installed?'기본 음성 설치됨':install.error==='VOICE_BASE_CHANGED'?'기본 음성 복구 설치':'기본 음성 설치')}</button>}
    {install.error&&<p role="alert">{t(errors[install.error]||'설치를 완료하지 못했습니다. 다시 시도해 주세요.')}</p>}
   </div>}
  </VoiceSetupStep>
  <VoiceSetupStep number={3} title="목소리 선택·추가">
  {qwen&&<p>{t('Qwen은 WAV 기준 음성을 사용합니다. VoxCPM2 학습팩의 LoRA 가중치는 적용되지 않습니다. 기존 학습팩은 그대로 보존됩니다.')}</p>}
  <label>{t('캐릭터 음성')}<select disabled={busy||!characterId} aria-label={t('캐릭터 음성')} value={selected} onChange={e=>void act({type:'bind',profile:e.target.value||null})}>{selected&&!profile&&<option value={selected}>{t('선택한 WAV 음성을 찾을 수 없습니다')}</option>}{!state.defaultProfile&&<option value="">{t('없음')}</option>}{state.profiles.map(p=><option disabled={qwen&&!isReferenceProfile(p)} value={p.id+'@'+p.version} key={p.id+'@'+p.version}>{p.id+'@'+p.version===state.defaultProfile?t('기본 음성 · VoxCPM2'):p.name}{p.id+'@'+p.version===state.defaultProfile?'':isReferenceProfile(p)?' · WAV':' · '+p.version}</option>)}</select></label>
  {state.referenceImport?.busy&&<div role="status">{t('WAV 가져오는 중')} <button onClick={()=>void act({type:'cancelReferenceImport'})}>{t('WAV 가져오기 중단')}</button></div>}
  {state.referenceImport?.error&&<p role="alert">{t(errors[state.referenceImport.error]||'WAV를 가져오지 못했습니다. 파일을 확인하고 다시 시도해 주세요.')}</p>}
  <details className="voice-reference-import"><summary>{t('WAV로 새 음성 추가')}</summary>
   <strong>{t('WAV 기준 클로닝 · 학습 없음')}</strong><p>{t('사용 권한이 있는 한 명의 또렷한 발화를 선택하세요. 결과는 AI 합성 음성입니다.')}</p>
   <small>{t('2~20초 · 최대 20MiB · PCM 16/24비트 또는 float32 · 모노/스테레오')}</small>
   <label>{t('새 음성 이름')}<input aria-label={t('새 음성 이름')} value={name} maxLength={80} disabled={busy} onChange={e=>setName(e.target.value)}/></label>
   <label><input type="checkbox" checked={acknowledged} disabled={busy} onChange={e=>setAcknowledged(e.target.checked)}/>{t('이 음성을 사용할 권한이 있습니다.')}</label>
   <button disabled={busy||state.referenceImport?.busy||!name.trim()||!acknowledged} onClick={()=>void act({type:'importReference',name,acknowledged})}>{t(state.referenceImport?.busy?'WAV 가져오는 중':'WAV로 음성 추가')}</button>
   <small>{t('저장 후 캐릭터 음성 목록에서 직접 선택하면 적용됩니다. 가져오기만으로 현재 음성을 바꾸거나 모델을 다운로드하지 않습니다.')}</small>
  </details>
  </VoiceSetupStep>
  <VoiceSetupStep number={4} title="시험 재생·적용">
   <p>{t('선택은 저장됩니다. 파일과 목소리를 확인한 뒤 음성을 켜고 시험하세요.')}</p>
  <label><input disabled={busy||unsupported&&!state.enabled} aria-describedby={unsupported?'voice-platform-support':undefined} type="checkbox" checked={state.enabled} onChange={e=>void act({type:'enabled',value:e.target.checked})}/>{t('음성 사용')}</label>
  <label><input disabled={busy} type="checkbox" checked={state.autoRead} onChange={e=>void act({type:'auto',value:e.target.checked})}/>{t('새 답변 자동 읽기')}</label>
  <label>{t('음량')}<input disabled={busy} aria-label={t('음량')} type="range" min="0" max="1" step="0.05" value={state.volume} onChange={e=>void act({type:'volume',value:Number(e.target.value)})}/></label>
  <button disabled={busy||!playbackReady||!state.enabled||!selected||!state.runtimeConfigured} onClick={()=>void act({type:'test'})}>{t('시험 재생')}</button>
  {!playbackReady&&<small>{t('시험 재생은 로컬 캐릭터 대화를 연 뒤 사용할 수 있어요.')}</small>}
   <div className="button-row"><button disabled={!!preparationReason} aria-describedby="voice-preparation-help" onClick={()=>void act({type:'prepare'})}>{t('음성 엔진 미리 준비')}</button><small id="voice-preparation-help">{t(preparationReason||'캐릭터챗을 열지 않고 엔진만 준비해요. 말하거나 대화를 만들지 않아요. Dots 무음과 음량 0은 준비를 막지 않아요.')}</small></div>
   {state.status==='loading'&&<div className="voice-loading" role="status"><span>{t('모델 로딩·목소리 분석 중')}</span><progress aria-label={t('모델 준비 진행 중')}/><button onClick={()=>void act({type:'stop'})}>{t('모델 준비 중단')}</button></div>}
   {state.runtimeConfigured&&state.status!=='loading'&&<small role="status">{t(state.engineReady?'모델 준비 완료 · 다음 발화에서 재사용합니다.':'파일 연결 완료 · 처음 발화 전에 모델 준비가 필요합니다.')}</small>}
   <small>{t('Dots 발화 뒤 모델을 유지합니다. Dots 음소거는 Dots 전용 모델을 해제하고 로컬챗이 쓰는 모델은 유지합니다. 전체 음성 OFF는 모델을 해제합니다.')}</small>
  </VoiceSetupStep>
  <details className="voice-advanced"><summary>{t('고급 설정·보유한 파일 연결')}</summary>
  {qwen&&<><p>{t('Qwen은 WAV 기준 음성을 사용합니다. VoxCPM2 학습팩의 LoRA 가중치는 적용되지 않습니다. 기존 학습팩은 그대로 보존됩니다.')}</p><p role="status">{t(qwenGguf?(isStreamingProfile(state.executionProfile)?'Qwen GGUF는 합성 중 생성되는 음성을 순서대로 재생합니다. 로컬 캐릭터챗에서 중단이 확인되면 준비된 엔진을 다음 요청에 재사용합니다.':'Qwen GGUF는 각 구간의 합성이 끝난 뒤 재생합니다. 로컬 캐릭터챗에서 정상 재생 후 준비된 엔진을 다음 요청에 재사용합니다.'):(isStreamingProfile(state.executionProfile)?'Qwen MLX는 합성 중 생성되는 음성을 순서대로 재생합니다. 중단하면 전용 엔진을 종료하고 다음 요청에서 다시 준비합니다.':'Qwen은 각 구간의 합성이 끝난 뒤 재생합니다. 중단하면 전용 엔진을 종료하고 다음 요청에서 다시 준비합니다.'))}</p></>}
  {reference&&<div className="voice-reference-info"><strong>{t('WAV 기준 클로닝 · 학습 없음')}</strong>{!reference.error&&<small>{t('기준 음성')}: {(reference.reference.durationMs/1000).toFixed(1)}s · {reference.reference.sampleRate}Hz · {t('모노')}</small>}<label>{t('음성 이름')}<input aria-label={t('음성 이름')} value={rename} maxLength={80} disabled={busy} onChange={e=>setRename(e.target.value)}/></label><button disabled={busy||!rename.trim()||rename.trim()===reference.name} onClick={()=>void act({type:'renameReference',profile:selected,name:rename})}>{t('이름 변경')}</button></div>}

  {qwen&&<div className="voice-qwen-settings">{qwenGguf?<details className="voice-manual-runtime"><summary>{t('보유한 GGUF 실행 환경 수동 연결')}</summary><button disabled={busy} onClick={()=>void act({type:'configureQwenGguf'})}>{t(qwenConfigured?'Qwen GGUF 런타임 다시 연결':'Qwen GGUF Python·DLL·모델 연결')}</button><small>{t('호환되는 실행 환경을 이미 준비한 경우에만 Python, 선택한 백엔드의 DLL, Base Q8·codec Q8 모델 폴더를 직접 연결하세요.')}</small></details>:<button disabled={busy} onClick={()=>void act({type:'configureQwen'})}>{t(qwenConfigured?'Qwen 런타임 다시 연결':'Qwen 전용 런타임·모델 연결')}</button>}{qwenGguf&&<small>{t('qwentts.cpp는 커뮤니티 MIT 런타임이며 Qwen 공식 실행 환경이 아닙니다. 변환 모델은 Apache-2.0입니다.')}</small>}<label>{t('기준 음성 사용 방식')}<select aria-label={t('기준 음성 사용 방식')} disabled={busy} value={cloneMode} onChange={e=>setCloneMode(e.target.value as 'x-vector'|'icl')}><option value="x-vector">{t('화자 임베딩만 · X-vector')}</option><option value="icl">{t('정확한 기준 문장과 함께 · ICL')}</option></select></label>{cloneMode==='icl'&&<label>{t('기준 WAV의 정확한 문장')}<textarea aria-label={t('기준 WAV의 정확한 문장')} maxLength={2000} disabled={busy} value={transcript} onChange={e=>setTranscript(e.target.value)}/></label>}<button disabled={busy||cloneMode==='icl'&&!transcript.trim()} onClick={()=>void act({type:'qwenClone',value:{mode:cloneMode,transcript:cloneMode==='icl'?transcript:''}})}>{t('기준 음성 방식 적용')}</button><small>{t('두 방식의 품질과 지연은 기준 음성과 문장에 따라 달라집니다.')}</small></div>}
  {voxGguf&&<details className="voice-vox-gguf-settings voice-manual-runtime"><summary>{t('보유한 GGUF 실행 환경 수동 연결')}</summary><button disabled={busy} onClick={()=>void act({type:'configureVoxGguf'})}>{t(state.voxGgufConfigured?'VoxCPM2 Windows GGUF 런타임 다시 연결':'VoxCPM2 Windows GGUF 실행 환경 연결')}</button><p>{t(trained?'이 경로는 VoxCPM2 학습팩의 LoRA를 반영한 F16 GGUF를 재사용합니다. Qwen의 WAV 기준 복제와 달리 학습 가중치가 유지됩니다.':reference?'공개 VoxCPM2 F16 GGUF와 WAV 기준 음성으로 복제합니다. 공개 모델에는 개인 학습팩의 LoRA 가중치가 포함되지 않습니다.':'공개 VoxCPM2 F16 GGUF의 기본 음성을 사용합니다. 개인 학습팩의 LoRA 가중치는 포함되지 않습니다.')}</p><small>{t(trained?'Python, 원본 VoxCPM2 모델, Windows EXE·DLL, 변환 기록과 F16 GGUF 두 파일, 실행 승인 기록을 차례로 선택합니다.':'Python, 공개 F16 GGUF 모델 폴더, Windows EXE·DLL과 실행 승인 기록을 차례로 선택합니다.')}</small><small>{t('호환되는 Mac F16 변환 결과는 검증 후 재사용할 수 있습니다. 원본 학습팩과 모델은 보존되며 자동 변환·설치는 하지 않습니다.')}</small></details>}
  {state.modelVerification&&<div className="voice-model-verification"><label>{t('모델 준비 검사')}<select disabled={busy||fullModelVerification} value={fullModelVerification?'full':state.modelVerification} onChange={e=>void act({type:'modelVerification',value:e.target.value as 'full'|'installed'})}><option value="full">{t('준비할 때 전체 검사')}</option>{!fullModelVerification&&<option value="installed">{t('설치 때 검사 · 빠른 준비')}</option>}</select></label><small>{t(voxGguf?(trained?'GGUF 준비와 모델 검사에서 파생 모델과 실행 파일의 전체 해시를 확인합니다. 원본 VoxCPM2 모델의 전체 검사는 기존 PyTorch 실행 모드에서 사용할 수 있습니다.':'GGUF 준비와 모델 검사에서 공개 F16 모델 파일의 SHA-256을 확인합니다.'):qwenGguf?'Qwen GGUF는 새 엔진을 준비할 때 Base와 codec 모델 파일 전체를 검사합니다.':state.modelVerification==='installed'?'다운로드·설치 때 전체 검사합니다. 준비할 때는 큰 모델 파일의 해시를 읽지 않아 설치 후 손상을 모두 발견하지 못합니다. 모델 로딩·음성 분석·첫 컴파일은 여전히 필요합니다.':'새 음성 엔진을 준비할 때 모델 파일 전체를 검사합니다.')}</small>{state.modelCheck?.busy?<><span role="status">{t(voxGguf&&trained?'GGUF 파생 모델·실행 파일 전체 검사 중':'모델 전체 검사 중')}</span><button onClick={()=>void act({type:'cancelModelCheck'})}>{t('검사 중단')}</button></>:<button disabled={busy} onClick={()=>void act({type:'checkModel'})}>{t(voxGguf&&trained?'GGUF 파생 모델·실행 파일 전체 검사':'모델 전체 검사')}</button>}{state.modelCheck?.completedAt&&!state.modelCheck.error&&<span role="status">{t(voxGguf&&trained?'GGUF 파생 모델·실행 파일 전체 검사 완료':'모델 전체 검사 완료')}</span>}{state.modelCheck?.error&&<p role="alert">{t(errors.VOICE_MODEL_CHECK_FAILED)}</p>}</div>}
  <ManagedVoiceModels state={state} busy={busy} act={act} group="current"/>
  <GgufModels state={state} busy={busy} act={act} exclude={qwenGguf?'qwen3-tts-06b-gguf':voxGguf&&!trained?'voxcpm2-gguf-f16':undefined}/>
  <SeedSettings state={state} act={act} busy={busy}/>
  <label>{t('재생 방식')}<select disabled={busy} aria-label={t('음성 실행 모드')} value={state.executionProfile||'baseline'} onChange={e=>void act({type:'executionProfile',value:e.target.value as ExecutionProfile})}>{(state.availableProfiles||[]).map(profile=><option key={profile} value={profile}>{{'qwen-complete':t('Qwen · 완성 후 재생'),'qwen-mlx':t('Qwen MLX · 청크 재생'),'qwen-mlx-complete':t('Qwen MLX · 완성 후 재생'),'qwen-gguf':t('Qwen GGUF CUDA · 청크 재생'),'qwen-gguf-complete':t('Qwen GGUF CUDA · 완성 후 재생'),'qwen-gguf-vulkan':t('Qwen GGUF Vulkan · 청크 재생'),'qwen-gguf-vulkan-complete':t('Qwen GGUF Vulkan · 완성 후 재생'),'gguf-cuda-f16':t('VoxCPM2 GGUF CUDA · 청크 재생'),'gguf-cuda-f16-complete':t('VoxCPM2 GGUF CUDA · 완성 후 재생'),'gguf-vulkan-f16':t('VoxCPM2 GGUF Vulkan · 청크 재생'),'gguf-vulkan-f16-complete':t('VoxCPM2 GGUF Vulkan · 완성 후 재생'),baseline:t('Windows 기준 · 완성 후 재생'),cached:t('Windows 캐시 · 청크 재생'),compiled:t('CUDA · 청크 재생'),'mps-fp32-baseline':t('이전 모드'),'mps-fp32':t('이전 모드'),'gguf-metal-f16':t('Metal · 청크 재생'),'gguf-metal-f16-complete':t('Metal · 완성 후 재생'),'cuda-compiled':t('CUDA · 청크 재생'),'cuda-compiled-complete':t('CUDA · 완성 후 재생')}[profile]}</option>)}</select></label>
  <small>{state.executionProfile?.endsWith('-complete')||state.executionProfile==='baseline'?t('각 발화 구간의 합성을 끝낸 뒤 재생합니다. 구간 사이에 대기 시간이 있을 수 있어요.'):t('음성이 만들어지는 동안 순서대로 재생합니다.')}</small>

   <div className="button-row"><button disabled={busy} onClick={()=>void act({type:'import'})}>{t('음성 패키지 가져오기')}</button>{!qwen&&!voxGguf&&!managed&&<button disabled={busy} onClick={()=>void act({type:'configure'})}>{t('TTS 런타임·모델 연결')}</button>}
   <button className="destructive-text" disabled={busy||!selected||builtin} onClick={()=>void act({type:'remove',profile:selected})}>{t('선택 음성 삭제')}</button></div>
   {!voxGguf&&!managed&&state.executionProfile?.startsWith('gguf-')&&<small>{t('처음 사용할 때 실행용 음성을 준비하고 다음부터는 저장된 결과를 재사용합니다. 원본 모델과 LoRA는 보존됩니다.')}</small>}
   {state.executionProfile==='compiled'&&<small>{t('처음 준비에는 컴파일 시간이 필요합니다. 준비 실패 시 기준 모드를 선택할 수 있습니다.')}</small>}
   {state.error==='COMPILE_UNAVAILABLE'&&<p>{t('CUDA 컴파일을 적용하지 못했습니다. 최적화 런타임을 연결하거나 다른 실행 모드를 선택해 주세요.')}</p>}
  </details>
 </section>
}

Object.assign(errors,{
 GGUF_RUNTIME_ARTIFACT_PENDING:'이 배포본에는 고정 GGUF 런타임 설치 파일이 없습니다. 설치 파일이 제공되는 배포본이나 고급 수동 연결을 이용하세요.',
 GGUF_RUNTIME_UNSUPPORTED:'GGUF 실행 환경 자동 준비는 Windows x64에서 사용할 수 있습니다.',
 GGUF_RUNTIME_BUSY:'다른 실행 환경 작업이 진행 중입니다. 중단하거나 완료된 뒤 다시 시도해 주세요.',
 GGUF_RUNTIME_CHANGED:'GGUF 실행 환경 파일이 없거나 검사에 실패했습니다. 실행 환경 복구를 눌러 주세요.',
 GGUF_RUNTIME_DISK_SPACE:'GGUF 실행 환경을 준비할 저장 공간이 부족합니다.',
 GGUF_RUNTIME_DOWNLOAD_FAILED:'실행 환경 다운로드가 중단됐습니다. 연결 상태를 확인한 뒤 다시 준비해 주세요.',
 GGUF_RUNTIME_DOWNLOAD_ACCESS:'실행 환경 설치 파일에 접근할 수 없습니다. 설치 파일이 제공되는 배포본을 확인해 주세요.',
 GGUF_RUNTIME_DOWNLOAD_RANGE:'실행 환경 다운로드를 이어 받지 못했습니다. 다시 준비해 주세요.',
 GGUF_RUNTIME_DOWNLOAD_SIZE:'실행 환경 설치 파일의 크기가 맞지 않습니다. 다시 준비해 주세요.',
 GGUF_RUNTIME_FILESYSTEM_FAILED:'실행 환경 파일을 저장하지 못했습니다. 저장 폴더와 여유 공간을 확인해 주세요.',
 GGUF_RUNTIME_PATH_TOO_LONG:'앱 데이터 폴더 경로가 너무 길어 실행 환경을 준비할 수 없습니다. 더 짧은 앱 데이터 위치를 사용해 주세요.',
 GGUF_RUNTIME_UNKNOWN:'선택한 GGUF 실행 환경을 찾지 못했습니다. 지원되는 엔진과 재생 방식을 선택해 주세요.',
 GGUF_RUNTIME_INSTALL_FAILED:'실행 환경을 준비하지 못했습니다. 설치 파일과 저장 공간을 확인하고 다시 시도해 주세요.',
 GGUF_RUNTIME_RECOVERY:'실행 환경 정리가 남아 있습니다. 앱을 다시 시작한 뒤 복구를 눌러 주세요.',
 GGUF_RUNTIME_TERMS_REQUIRED:'Microsoft 음성 실행 파일 이용 조건을 확인하고 직접 수락해 주세요.',
 GGUF_RUNTIME_TERMS_CHANGED:'이용 조건 문서 또는 적용 파일이 변경되었습니다. 배포본을 확인해 주세요.',
 GGUF_RUNTIME_TERMS_OPEN_FAILED:'이용 조건 문서를 열지 못했습니다. 텍스트 보기로 확인해 주세요.',
 GGUF_RUNTIME_ADMISSION:'관리형 GGUF 실행 환경을 확인하지 못했습니다. 복구와 전체 검사를 실행해 주세요.',
 GGUF_MANAGED_RUNTIME_CHANGED:'GGUF 실행 환경 파일이 없거나 검사에 실패했습니다. 실행 환경 복구를 눌러 주세요.',
 GGUF_MANAGED_GPU_UNSUPPORTED:'CUDA GPU를 확인하지 못했습니다. NVIDIA GPU와 그래픽 드라이버 상태를 확인해 주세요.',
 GGUF_MANAGED_DRIVER_UNSUPPORTED:'현재 GGUF CUDA 빌드는 CUDA 13을 지원하는 R580 이상 NVIDIA 드라이버가 필요합니다. GPU 드라이버를 확인해 주세요.'
})
function VoiceFilesPreparation({state,busy,act,trained}:{state:VoiceSnapshot;busy:boolean;act:(value:VoiceAction)=>unknown;trained:boolean}){
 const t=useT(),id:GgufRuntimeId|undefined=state.engine==='qwen3-tts-06b-gguf'?state.executionProfile?.includes('vulkan')?'qwen-vulkan':'qwen-cuda':isWindowsVoxGgufProfile(state.executionProfile)?state.executionProfile?.includes('vulkan')?'vox-vulkan':'vox-cuda':undefined
 if(!id)return null
 const runtime=state.ggufRuntimeInstall?.find(value=>value.id===id),file=state.filePreparation?.id===id?state.filePreparation:undefined,canPrepare=!!runtime?.supported&&runtime.available,needsDerivative=id.startsWith('vox')&&trained&&!state.voxGgufConfigured
 return <div className="voice-files-preparation">
  <strong>{t('모델과 실행 환경을 함께 준비')}</strong>
  <p>{t('필요한 파일을 받고 검사한 뒤 현재 엔진에 연결합니다. 목소리 선택과 시험 재생은 다음 단계입니다.')}</p>
  <small>{t(id.endsWith('cuda')?'지원 장치: NVIDIA CUDA · R580 이상 드라이버 필요 · RTX 4090에서 검증':'지원 장치: Vulkan · RTX 4090에서 검증, AMD·Intel은 검증 전')}</small>
  <small>{t('새 설치 기준 다운로드')}: {((id.startsWith('qwen')?1283766112:5073076896)/1e9).toFixed(2)} GB {t('모델')} + {((runtime?.total??0)/1e9).toFixed(2)} GB {t('실행 환경')}</small>
  <small>{t('모델 배포자')}: {id.startsWith('qwen')?'Serveurperso':'DennisHuang648'} · {t('커뮤니티 변환')} · Apache-2.0</small>
  {state.ggufRuntimeTerms&&<ManagedRuntimeTerms state={state.ggufRuntimeTerms} busy={busy} act={act}/>}
  {file?.busy?<><span role="status">{t(file.cancelling?'파일 작업 중단 확인 중':file.phase==='models'?'1/2 모델 받기·검사':'2/2 실행 환경 받기·검사·연결')}</span><button disabled={file.cancelling} onClick={()=>void act({type:'cancelPrepareVoiceFiles'})}>{t('파일 준비 중단')}</button></>:<button className="button primary" disabled={busy||!canPrepare||needsDerivative||!!state.ggufRuntimeTerms&&!state.ggufRuntimeTerms.accepted} onClick={()=>void act({type:'prepareVoiceFiles'})}>{t(file?.phase==='error'?'필요한 파일 준비 다시 시도':(id.startsWith('qwen')?state.qwenGgufConfigured:state.voxGgufConfigured)?'받은 파일 검사·다시 연결':'필요한 파일 받기·연결')}</button>}
  {!canPrepare&&<p className="notice" role="status">{t('자동 준비용 실행 환경이 이 배포본에 제공되지 않았습니다. 모델만 받아도 음성이 연결되지 않습니다. 고급 설정에서 검증된 실행 환경을 연결할 수 있습니다.')}</p>}
  {needsDerivative&&<p role="status">{t('이 학습팩의 변환 결과를 먼저 연결해 주세요. 공개 모델로 개인 학습 가중치를 대체하지 않습니다.')}</p>}
  {file?.phase==='connected'&&<p role="status">{t('필요한 파일을 검사하고 엔진에 연결했습니다. 목소리를 선택한 뒤 음성을 준비하세요.')}</p>}
  {file?.phase==='cancelled'&&<p role="status">{t('파일 준비를 중단했습니다. 다시 시도하면 받은 파일을 재사용합니다.')}</p>}
  {file?.phase==='deferred'&&<p role="status">{t('선택이 바뀌어 자동 연결을 멈췄습니다. 현재 엔진에서 다시 준비하세요.')}</p>}
  {file?.error&&<p role="alert">{t(errors[file.error]||'파일 준비에 실패했습니다. 연결 상태와 저장 공간을 확인하고 다시 시도해 주세요.')}</p>}
 </div>
}
function GgufRuntimeSetup({state,busy,act}:{state:VoiceSnapshot;busy:boolean;act:(value:VoiceAction)=>unknown}){
 const t=useT(),id:GgufRuntimeId|undefined=state.engine==='qwen3-tts-06b-gguf'?state.executionProfile?.includes('vulkan')?'qwen-vulkan':'qwen-cuda':isWindowsVoxGgufProfile(state.executionProfile)?state.executionProfile?.includes('vulkan')?'vox-vulkan':'vox-cuda':undefined
 if(!id)return null
 const runtime=state.ggufRuntimeInstall?.find(s=>s.id===id),setup=state.ggufRuntimeSetup,owns=setup?.id===id,active=!!runtime&&runtime.phase!=='idle'||owns&&(!!setup.busy||!!setup.cancelling),canPrepare=!!runtime?.supported&&runtime.available
 const error=runtime?.error||(owns?setup?.error:undefined)||(!runtime?setup?.error:undefined)||(!runtime?.available?runtime?.blockedReason:undefined)
 return <details className="voice-runtime-details" open={active}><summary>{t('실행 환경 상태·복구')}</summary><div className="voice-install voice-gguf-runtime"><strong>{id.startsWith('qwen')?'Qwen GGUF':'VoxCPM2 GGUF'} · {id.endsWith('cuda')?'CUDA':'Vulkan'}</strong><p>{t('GGUF 실행 환경 준비')}</p><small>{t('Python과 필요한 실행 파일을 자동으로 준비합니다. CUDA SDK나 새 GPU 드라이버를 설치하지 않습니다.')}</small><small>{t(id.endsWith('cuda')?'CUDA 빌드는 R580 이상 NVIDIA 드라이버가 필요합니다. GPU 세대 제한 없이 실행을 시도하며, RTX 4090에서 검증했습니다.':'Vulkan 경로는 RTX 4090에서 검증했습니다. AMD·Intel GPU는 아직 검증하지 않았습니다.')}</small>{runtime&&<small>{t('실행 환경 다운로드')}: {(runtime.total/1e9).toFixed(2)} GB</small>}
 {active?<><span role="status">{t(setup?.cancelling?'실행 환경 중단 확인 중':runtime?.phase==='downloading'?'실행 환경 다운로드 중':runtime?.phase==='extracting'?'실행 환경 압축 해제 중':runtime?.phase==='verifying'?'실행 환경 전체 검사 중':'실행 환경 준비 중')}</span><progress aria-label={t('GGUF 실행 환경 진행률')} {...(runtime?.phase==='downloading'?{value:runtime.bytes,max:runtime.total}:{})}/><button disabled={!!setup?.cancelling} onClick={()=>void act({type:state.filePreparation?.busy?'cancelPrepareVoiceFiles':'cancelInstallGgufRuntime'})}>{t('실행 환경 작업 중단')}</button></>:<div className="button-row"><button disabled={busy||!canPrepare||!!state.ggufRuntimeTerms&&!state.ggufRuntimeTerms.accepted} onClick={()=>void act({type:'installGgufRuntime',id})}>{t(runtime?.installed?'검사한 실행 환경 연결':'실행 환경 자동 준비')}</button><button disabled={busy||!canPrepare||runtime?.repairAvailable===false||!!state.ggufRuntimeTerms&&!state.ggufRuntimeTerms.accepted} onClick={()=>void act({type:'repairGgufRuntime',id})}>{t('실행 환경 복구')}</button><button disabled={busy||!runtime?.supported||!runtime.installed||!!state.ggufRuntimeTerms&&!state.ggufRuntimeTerms.accepted} onClick={()=>void act({type:'verifyGgufRuntime',id})}>{t('실행 환경 전체 검사')}</button></div>}
 {runtime?.verified&&<small role="status">{t('실행 환경 파일 검사 완료 · GPU 발화 준비는 별도입니다.')}</small>}
 {owns&&setup.application==='connected'&&<small role="status">{t('현재 엔진·재생 방식의 실행 환경과 모델을 연결했습니다. 음성 사용을 켜고 미리 준비하거나 시험 재생하세요.')}</small>}
 {owns&&setup.application==='model-required'&&<small role="status">{t('실행 환경 파일은 준비됐습니다. 선택한 음성의 모델을 준비한 뒤 실행 환경 연결을 다시 눌러 주세요.')}</small>}
 {owns&&setup.application==='deferred'&&<small role="status">{t('실행 환경은 저장했지만 선택이 바뀌어 연결하지 않았습니다. 현재 선택에서 다시 연결하세요.')}</small>}
 {error&&<p role="alert">{t(errors[error]||'실행 환경을 준비하지 못했습니다. 설치 파일과 저장 공간을 확인하고 다시 시도해 주세요.')}</p>}
 {!runtime?.available&&<small>{t('이 배포본에는 고정 GGUF 런타임 설치 파일이 없습니다. 설치 파일이 제공되는 배포본이나 고급 수동 연결을 이용하세요.')}</small>}
 <small>{t('모델 다운로드만으로 엔진을 바꾸지 않습니다. 실행 환경 연결은 현재 선택한 엔진과 재생 방식에만 적용됩니다.')}</small></div></details>
}
function GgufModels({state,busy,act,model:chosen,exclude,expanded=false,currentOnly=false}:{state:VoiceSnapshot;busy:boolean;act:(value:VoiceAction)=>unknown;model?:import('../../electron/shared/character-voice-contract').GgufModelId;exclude?:import('../../electron/shared/character-voice-contract').GgufModelId;expanded?:boolean;currentOnly?:boolean}){
 const t=useT(),catalog=state.ggufCatalog||GGUF_MODEL_CATALOG
 if(voiceSetupPlatform(state).platform!=='win32')return null
 if(currentOnly&&!chosen)return null
 const models=catalog.models.filter(model=>(!chosen||model.id===chosen)&&model.id!==exclude)
 return <details className="voice-gguf-models" open={expanded||models.some(model=>state.ggufInstall?.some(value=>value.id===model.id&&value.phase!=='idle'))}><summary>{t('GGUF 모델 다운로드·검사')}</summary><p>{t('공개 커뮤니티 변환 모델입니다. Qwen·OpenBMB 제작자가 직접 배포한 공식 GGUF가 아닙니다.')}</p><small>{t('모델 파일만 내려받습니다. Python·CUDA·Vulkan 실행 환경은 포함되지 않으며, 다운로드만으로 엔진이나 캐릭터 음성을 바꾸지 않습니다.')}</small>{models.map(model=>{
  const install=state.ggufInstall?.find(value=>value.id===model.id),active=!!install&&install.phase!=='idle'
  return <div className="voice-install" key={model.id}><strong>{model.title}</strong><small>{model.repository} · {model.publisher} · {model.license}</small><small>{t('다운로드 총')}: {(model.totalBytes/1e9).toFixed(2)} GB · {t('설치 여유 공간')}: {(model.minimumFreeBytes/1024**3).toFixed(1)} GiB</small><details><summary>{t('모델 배포·파일 정보')}</summary><small>{t('고정 버전')}: {model.revision}</small>{model.files.map(file=><small key={file.name}>{file.name} · {file.bytes.toLocaleString(t.locale)} bytes · SHA-256 {file.sha256}</small>)}<small>{t('실행 환경')}: {model.runtimeRepository} · {model.runtimeCommit}</small>{install?.modelPath&&<small>{t('모델 위치')}: {install.modelPath}</small>}</details>{active?<><span role="status">{t(install.phase==='downloading'?'다운로드 중':install.phase==='verifying'?'파일 검증 중':install.phase==='publishing'?'모델 설치 중':'설치 준비 중')}</span><progress aria-label={t('GGUF 모델 다운로드 진행률')} {...(install.phase==='downloading'?{value:install.bytes,max:install.total}:{})}/><button onClick={()=>void act({type:state.filePreparation?.busy?'cancelPrepareVoiceFiles':'cancelInstallGgufModel'})}>{t('GGUF 모델 작업 중단')}</button></>:<div className="button-row"><button disabled={busy||!install?.supported||install.installed} onClick={()=>void act({type:'installGgufModel',id:model.id})}>{t(install?.installed?'GGUF 모델 설치됨':'GGUF 모델 다운로드·설치')}</button><button disabled={busy||!install?.supported||!install.modelPath} onClick={()=>void act({type:'verifyGgufModel',id:model.id})}>{t('GGUF 모델 SHA-256 검사')}</button></div>}{install?.verified&&<small role="status">{t('GGUF 모델 SHA-256 검사 완료')}</small>}{install?.error&&<p role="alert">{t(errors[install.error]||'GGUF 모델 다운로드 또는 검사에 실패했습니다. 연결 상태와 저장 공간을 확인한 뒤 다시 시도해 주세요.')}</p>}</div>
 })}</details>
}
function ManagedVoiceModels({state,busy,act,group}:{state:VoiceSnapshot;busy:boolean;act:(value:VoiceAction)=>unknown;group?:'legacy'|'current'}){
 busy=busy||['loading','synthesizing','playing'].includes(state.status)
 const t=useT(),platform=voiceSetupPlatform(state).platform,models=state.managedModels?.filter(model=>!group||isLegacyVoiceModel(model.id,platform)===(group==='legacy'))
 return <details className="voice-managed-models"><summary>{t(group==='legacy'?'레거시 모델 보관·삭제':'앱이 받은 음성 모델 관리')}</summary><small>{t('앱이 받은 모델과 모델 다운로드 캐시만 관리합니다. 외부 모델, 개인 학습 GGUF, 학습팩과 기준 WAV는 목록에 포함하지 않습니다.')}</small><button disabled={busy} onClick={()=>void act({type:'refreshManagedModels'})}>{t('모델 목록 새로고침')}</button>{state.managedModelRemoval?.busy&&<p role="status">{t('앱 관리 모델 정리 중')}</p>}{models?.length?models.map(model=><div key={model.id}><strong>{model.modelId}</strong><small>{t(model.currentVoiceAffected?'현재 목소리가 사용하는 모델 · 삭제 후 다시 준비해야 합니다.':'선택한 목소리를 유지하고 보관 모델을 정리할 수 있습니다.')}</small><small>{t('고정 버전')}: {model.revision}</small><small>{t('휴지통으로 옮길 용량')}: {model.totalBytes.toLocaleString(t.locale)} bytes</small><small>{t('휴지통을 비우기 전까지 저장 공간을 계속 사용합니다. 필요하면 복원한 뒤 다시 연결할 수 있습니다.')}</small>{model.directories.map(directory=><small key={directory.path}>{directory.path} · {directory.bytes.toLocaleString(t.locale)} bytes</small>)}<button className="destructive-text" disabled={busy} onClick={()=>void act({type:'removeManagedModel',id:model.id})}>{t('모델 삭제 대상 확인')}</button></div>):<p>{t(state.managedModels?'앱이 관리하는 삭제 대상 모델이 없습니다.':'모델 목록을 새로고침해 삭제 대상을 확인하세요.')}</p>}{state.managedModelRemoval?.error&&<p role="alert">{t('모델 목록 또는 삭제 대상 검증에 실패했습니다. 목록을 새로고침해 주세요.')}</p>}</details>
}

function QwenInstall({state,reference,busy,act}:{state:VoiceSnapshot;reference:boolean;busy:boolean;act:(value:VoiceAction)=>unknown}){
 const t=useT(),install=state.qwenInstall!,active=install.phase!=='idle'
 const stage={idle:'Qwen 설치 완료',preparing:'Qwen 설치 준비 중',downloading:'Qwen 다운로드 중',installing:'Qwen 실행 환경 준비 중',verifying:'Qwen 파일 검증 중',applying:'Qwen 엔진 적용 중'}[install.phase]
 return <div className="voice-install voice-qwen-install" aria-label={t('Qwen 다운로드 및 설치')}>
  <strong>Qwen3-TTS 0.6B</strong><small className="voice-model-name">{install.model}</small>
  <small>{t(install.communityConversion?'Mac · mlx-community MLX 4bit 변환 모델':'Windows · Qwen 공식 원본 모델')} · {install.license}</small>
  <small>{t('모델')} {(install.modelBytes/1e9).toFixed(2)} GB + {t('실행 환경')} {(install.runtimeBytes/1e9).toFixed(2)} GB · {t('다운로드 총')} {(install.total/1e9).toFixed(2)} GB</small>
  <small>{t('설치 여유 공간')} {(install.minimumFreeBytes/1024**3).toFixed(0)} GiB · {t(install.communityConversion?'Python·MLX 실행 환경도 앱 전용 폴더에 설치합니다.':'Python·PyTorch CUDA 실행 환경도 앱 전용 폴더에 설치합니다. BF16 지원 NVIDIA GPU가 필요합니다.')}</small>
  <small>{t('검증이 끝나면 Qwen 엔진에 적용합니다. 설치만으로 말하거나 대화를 열지 않습니다.')}</small>
  {active?<div className="voice-qwen-progress"><span role="status" aria-live="polite">{t(stage)}{install.phase==='downloading'?' '+Math.floor(install.bytes/install.total*100)+'%':''}</span><progress aria-label={t('Qwen 설치 진행률')} {...(install.phase==='downloading'?{value:install.bytes,max:install.total}:{})}/><button onClick={()=>void act({type:'cancelInstallQwen'})}>{t('Qwen 설치 중단')}</button></div>:<button disabled={busy} onClick={()=>void act({type:'installQwen'})}>{t(install.repairNeeded?'Qwen 복구 설치 후 적용':install.installed?'설치된 Qwen 적용':install.error?'Qwen 설치 다시 시도':'Qwen 다운로드·설치 후 적용')}</button>}
  {!active&&install.installed&&<p role="status">{t(install.applicationDeferred?'Qwen 설치 완료. 현재 설정을 유지했습니다. 적용 버튼으로 연결해 주세요.':install.applied?'Qwen 런타임·모델 연결됨':'Qwen 설치 완료. 적용 버튼으로 연결해 주세요.')}</p>}
  {!reference&&<small>{t('Qwen에는 사용 권한이 있는 WAV 기준 음성을 직접 선택해야 합니다.')}</small>}
  {install.error&&<p role="alert">{t(errors[install.error]||'Qwen 설치를 완료하지 못했습니다. 다시 시도해 주세요.')}</p>}
 </div>
}

function SeedSettings({state,act,busy}:{state:VoiceSnapshot;act:(value:VoiceAction)=>unknown;busy:boolean}){
 const t=useT(),settings=state.seedSettings||DEFAULT_VOICE_SEED,[fixed,setFixed]=useState(String(settings.fixedSeed))
 useEffect(()=>setFixed(String(settings.fixedSeed)),[settings.fixedSeed])
 const value=Number(fixed),valid=/^[0-9]+$/.test(fixed)&&validVoiceSeed(value)
 return <div className="voice-seed-settings"><label>{t('새 음성의 시드')}<select aria-label={t('새 음성의 시드')} disabled={busy} value={settings.mode} onChange={e=>void act({type:'seedSettings',value:{...settings,mode:e.target.value as typeof settings.mode}})}><option value="random-per-reply">{t('답변마다 무작위')}</option><option value="fixed">{t('고정')}</option></select></label><small>{t('새로 만들 때 말투·억양이 달라질 수 있습니다. 변경은 다음 합성부터 적용됩니다.')}</small>{(settings.mode==='fixed'||state.seedError)&&<><label>{t('고정 시드')}<input aria-label={t('고정 시드')} inputMode="numeric" value={fixed} onChange={e=>setFixed(e.target.value)} disabled={busy}/></label><button disabled={busy||!valid} onClick={()=>void act({type:'seedSettings',value:{mode:settings.mode,fixedSeed:value}})}>{t('시드 설정 적용')}</button></>}{state.lastGeneration&&<details><summary>{t('마지막 생성 정보')}</summary><label>{t('사용한 시드')}<input readOnly aria-label={t('사용한 시드')} value={state.lastGeneration.effectiveSeed}/></label><small>{t('선택하여 복사할 수 있습니다. 같은 시드의 재합성이 다른 환경에서 같은 음성을 보장하지는 않습니다.')}</small></details>}</div>
}
export function MessageVoiceControls({messageId}:{messageId:string}){
 const t=useT(),[state,setState]=useState<VoiceSnapshot|null>(null)
 useEffect(()=>{const api=window.characterVoice;if(!api)return;let live=true;const off=api.subscribe(s=>{if(live)setState(s)});void api.action({type:'snapshot'}).then(s=>{if(live)setState(s)}).catch(()=>{});return()=>{live=false;off()}},[])
 const result=state?.results?.[messageId],action=result?.cached?'replay':result?'reproduce':'read',label=result?'다시 듣기':'재생'
 const run=(type:'read'|'replay'|'reroll'|'reproduce')=>void window.characterVoice.action({type,messageId}).catch(()=>{})
 return <div className="message-voice-actions"><button disabled={!state?.enabled} aria-label={t(label)} onClick={()=>run(action)}>{t(label)}</button><details><summary>{t('음성 옵션')}</summary><button disabled={!state?.enabled} onClick={()=>run('reroll')}>{t('다른 시드로 다시 읽기')}</button>{result&&<button disabled={!state?.enabled} onClick={()=>run('reproduce')}>{t('같은 조건으로 다시 합성')}</button>}<button disabled={!state?.enabled} onClick={()=>run('read')}>{t('현재 설정으로 다시 합성')}</button>{result&&<small>{t('사용한 시드')}: {result.effectiveSeed} · {t(result.latestUnstored?'최신 결과 미보관':result.cached?'세션에 음성 보관 중':'음성 캐시 없음')}</small>}<small>{t('다시 합성해도 대화 내용은 바뀌지 않습니다. 음성 보관은 이 세션에서만 유지됩니다.')}</small></details></div>
}
