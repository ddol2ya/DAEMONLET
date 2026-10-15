import {expect,it} from 'vitest'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {VoiceSettings} from '../src/character-chat/VoiceControls'
import {ENGLISH_MESSAGES} from '../electron/shared/translations'
import type {VoiceSnapshot,GgufRuntimeId,GgufRuntimeInstallState,ExecutionProfile,VoiceEngine} from '../electron/shared/character-voice-contract'

const ids:GgufRuntimeId[]=['qwen-cuda','qwen-vulkan','vox-cuda','vox-vulkan']
const runtime=(id:GgufRuntimeId):GgufRuntimeInstallState=>({id,supported:true,available:true,repairAvailable:true,installed:false,verified:false,phase:'idle',bytes:0,total:340000000,error:null})
const state:VoiceSnapshot={epoch:1,enabled:false,autoRead:false,volume:.5,profiles:[],bindings:{},status:'off',error:null,runtimeConfigured:false,engine:'qwen3-tts-06b-gguf',availableEngines:['voxcpm2','qwen3-tts-06b','qwen3-tts-06b-gguf'],qwenGgufConfigured:false,executionProfile:'qwen-gguf',availableProfiles:['qwen-gguf','qwen-gguf-vulkan'],ggufRuntimeInstall:ids.map(runtime)}
const render=(value:VoiceSnapshot=state,busy=false)=>renderToStaticMarkup(createElement(VoiceSettings,{state:value,act:()=>{},playbackReady:true,busy}))
const card=(value:VoiceSnapshot=state,busy=false)=>render(value,busy).split('class="voice-install voice-gguf-runtime"')[1]?.split('<details class="voice-gguf-models"')[0]??''

it.each([
 ['qwen3-tts-06b-gguf','qwen-gguf','qwen-cuda','Qwen GGUF · CUDA'],
 ['qwen3-tts-06b-gguf','qwen-gguf-vulkan','qwen-vulkan','Qwen GGUF · Vulkan'],
 ['voxcpm2','gguf-cuda-f16','vox-cuda','VoxCPM2 GGUF · CUDA'],
 ['voxcpm2','gguf-vulkan-f16','vox-vulkan','VoxCPM2 GGUF · Vulkan']
] as const)('selects runtime controls for %s / %s only', (engine,executionProfile,id,title)=>{
 const value={...state,engine,executionProfile,availableProfiles:[executionProfile],ggufRuntimeInstall:ids.map(other=>({...runtime(other),available:other===id}))}
 const html=card(value);expect(html).toContain(title);expect(html).toContain('<button>실행 환경 자동 준비</button>');expect(html).toContain('CUDA SDK나 새 GPU 드라이버를 설치하지 않습니다.')
 if(id.endsWith('cuda'))expect(html).toContain('R580 이상 NVIDIA 드라이버')
 else expect(html).toContain('AMD·Intel GPU는 아직 검증하지 않았습니다.')
})
it.each([
 ['qwen3-tts-06b','qwen-complete'],['qwen3-tts-06b','qwen-mlx'],['voxcpm2','gguf-metal-f16'],['voxcpm2','cuda-compiled']
] as const)('does not attach Windows managed GGUF controls to %s / %s',(engine:VoiceEngine,executionProfile:ExecutionProfile)=>{
 expect(render({...state,engine,executionProfile,availableProfiles:[executionProfile]})).not.toContain('voice-gguf-runtime')
})
it('source-only distributions keep installation unavailable and expose advanced manual connections',()=>{
 const html=render({...state,ggufRuntimeInstall:[{...runtime('qwen-cuda'),available:false,blockedReason:'GGUF_RUNTIME_ARTIFACT_PENDING'}]})
 expect(card({...state,ggufRuntimeInstall:[{...runtime('qwen-cuda'),available:false}]})).toContain('<button disabled="">실행 환경 자동 준비</button>')
 expect(html).toContain('이 배포본에는 고정 GGUF 런타임 설치 파일이 없습니다.');expect(html).toContain('보유한 GGUF 실행 환경 수동 연결');expect(html).toContain('Qwen GGUF Python·DLL·모델 연결')
})
it.each(['preparing','downloading','extracting','verifying','publishing'] as const)('keeps %s cancellable while its page operation is pending',phase=>{
 const value={...state,ggufRuntimeInstall:[{...runtime('qwen-cuda'),phase,bytes:170000000}],ggufRuntimeSetup:{busy:true,id:'qwen-cuda' as const,error:null}}
 const html=card(value,true);expect(html).toContain('<button>실행 환경 작업 중단</button>');expect(html).not.toContain('실행 환경 자동 준비</button>');expect(html).toContain('GGUF 실행 환경 진행률')
 expect(card({...value,ggufRuntimeSetup:{...value.ggufRuntimeSetup,cancelling:true}},true)).toContain('<button disabled="">실행 환경 작업 중단</button>')
})
it('installed files can be checked without repair archives and are not presented as GPU speech ready',()=>{
 const value={...state,ggufRuntimeInstall:[{...runtime('qwen-cuda'),installed:true,verified:true,repairAvailable:false}],ggufRuntimeSetup:{busy:false,id:'qwen-cuda' as const,application:'connected' as const,error:null}}
 const html=card(value);expect(html).toContain('<button>실행 환경 전체 검사</button>');expect(html).toContain('<button disabled="">실행 환경 복구</button>');expect(html).toContain('실행 환경 파일 검사 완료 · GPU 발화 준비는 별도입니다.');expect(html).toContain('음성 사용을 켜고 미리 준비하거나 시험 재생하세요.')
 expect(html).toContain('모델 다운로드만으로 엔진을 바꾸지 않습니다.');expect(render(value)).toContain('<input type="checkbox"/>음성 사용')
})
it.each(['model-required','deferred'] as const)('retains an explicit reconnect route after %s',application=>{
 const html=card({...state,ggufRuntimeInstall:[{...runtime('qwen-cuda'),installed:true,verified:true}],ggufRuntimeSetup:{busy:false,id:'qwen-cuda',application,error:null}})
 expect(html).toContain('<button>검사한 실행 환경 연결</button>');expect(html).toContain(application==='model-required'?'모델을 준비한 뒤 실행 환경 연결을 다시':'선택이 바뀌어 연결하지 않았습니다.')
})
it.each([
 ['GGUF_RUNTIME_DOWNLOAD_FAILED','실행 환경 다운로드가 중단됐습니다. 연결 상태를 확인한 뒤 다시 준비해 주세요.'],
 ['GGUF_RUNTIME_DOWNLOAD_ACCESS','실행 환경 설치 파일에 접근할 수 없습니다. 설치 파일이 제공되는 배포본을 확인해 주세요.'],
 ['GGUF_RUNTIME_DOWNLOAD_RANGE','실행 환경 다운로드를 이어 받지 못했습니다. 다시 준비해 주세요.'],
 ['GGUF_RUNTIME_DOWNLOAD_SIZE','실행 환경 설치 파일의 크기가 맞지 않습니다. 다시 준비해 주세요.'],
 ['GGUF_RUNTIME_FILESYSTEM_FAILED','실행 환경 파일을 저장하지 못했습니다. 저장 폴더와 여유 공간을 확인해 주세요.'],
 ['GGUF_MANAGED_GPU_UNSUPPORTED','CUDA GPU를 확인하지 못했습니다. NVIDIA GPU와 그래픽 드라이버 상태를 확인해 주세요.'],
 ['GGUF_MANAGED_DRIVER_UNSUPPORTED','현재 GGUF CUDA 빌드는 CUDA 13을 지원하는 R580 이상 NVIDIA 드라이버가 필요합니다. GPU 드라이버를 확인해 주세요.']
])('%s provides translated guidance without diagnostic paths',(error,message)=>{
 expect(card({...state,ggufRuntimeInstall:[{...runtime('qwen-cuda'),error}]})).toContain(message);expect(ENGLISH_MESSAGES[message]).toBeTruthy()
 const unknown=card({...state,ggufRuntimeInstall:[{...runtime('qwen-cuda'),error:'/private/path/failed'}]});expect(unknown).not.toContain('/private/path');expect(unknown).toContain('다시 시도해 주세요.')
})
