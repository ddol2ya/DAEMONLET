import {expect,it} from 'vitest'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {VoiceSettings} from '../src/character-chat/VoiceControls'
import {ENGLISH_MESSAGES} from '../electron/shared/translations'
import type {VoiceSnapshot} from '../electron/shared/character-voice-contract'
const profiles:VoiceSnapshot['profiles']=[
 {id:'trained',version:'1',name:'Trained voice',fingerprint:'a',adapterSha256:'b'},
 {id:'wav-reference',version:'1',name:'Reference',kind:'wav-reference',fingerprint:'c',referenceSha256:'d',reference:{durationMs:5000,sampleRate:48000,channels:1,encoding:'pcm16',samples:240000,bytes:480044}},
 {id:'default',version:'1',name:'Default',kind:'base-default',adapterSha256:'none',fingerprint:'e'}
]
const state:VoiceSnapshot={epoch:1,enabled:true,autoRead:true,volume:.5,profiles,bindings:{test:'trained@1'},status:'idle',error:null,runtimeConfigured:true,engine:'voxcpm2',availableEngines:['voxcpm2','qwen3-tts-06b','qwen3-tts-06b-gguf'],voxGgufConfigured:false,availableProfiles:['gguf-cuda-f16','gguf-cuda-f16-complete','gguf-vulkan-f16','gguf-vulkan-f16-complete'],executionProfile:'gguf-cuda-f16',modelVerification:'installed'}
const render=(value:VoiceSnapshot=state)=>renderToStaticMarkup(createElement(VoiceSettings,{state:value,act:()=>{},playbackReady:true,characterId:'test'}))
it('Windows Vox GGUF connects audited external files and preserves trained weights without automatic conversion',()=>{
 const html=render()
 for(const text of ['VoxCPM2 Windows GGUF 실행 환경 연결','LoRA를 반영한 F16 GGUF','학습 가중치가 유지됩니다.','Mac F16 변환 결과','원본 학습팩과 모델은 보존','자동 변환·설치는 하지 않습니다.','실행 승인 기록','R580 이상 NVIDIA 드라이버','RTX 4090에서 검증했습니다.','VoxCPM2 GGUF CUDA · 청크 재생','VoxCPM2 GGUF CUDA · 완성 후 재생','VoxCPM2 GGUF Vulkan · 청크 재생','VoxCPM2 GGUF Vulkan · 완성 후 재생'])expect(html).toContain(text)
 expect(render({...state,executionProfile:'gguf-vulkan-f16'})).toContain('AMD·Intel GPU는 아직 검증하지 않았습니다.')
 expect(html).not.toContain('>TTS 런타임·모델 연결</button>');expect(html).not.toContain('처음 사용할 때 실행용 음성을 준비하고')
 expect(render({...state,voxGgufConfigured:true})).toContain('VoxCPM2 Windows GGUF 런타임 다시 연결')
})
it('Windows Vox GGUF separates trained derivatives from public F16 default and WAV voices',()=>{
 const html=render()
 expect(html).toMatch(/<option value="trained@1" selected="">/);expect(html).toMatch(/<option value="wav-reference@1">/);expect(html).toMatch(/<option value="default@1">/)
 expect(render({...state,bindings:{test:''},voxGgufConfigured:true})).toContain('기본 음성, WAV 기준 음성 또는 검증된 학습팩을 선택해 주세요.')
 const reference=render({...state,bindings:{test:'wav-reference@1'},voxGgufConfigured:true});expect(reference).toContain('공개 VoxCPM2 F16 GGUF');expect(reference).toContain('개인 학습팩의 LoRA 가중치가 포함되지 않습니다.');expect(reference).not.toContain('>GGUF 파생 모델·실행 파일 전체 검사</button>')
 expect(render({...state,bindings:{test:'default@1'},voxGgufConfigured:true})).toContain('공개 VoxCPM2 F16 GGUF의 기본 음성을 사용합니다.')
 expect(html).toContain('Windows GGUF 실행 환경과 해당 학습팩의 F16 파생 모델을 먼저 연결')
})
it('GGUF preparation and explicit checks target derivative models and runtime files, without claiming to verify original weights',()=>{
 const html=render();expect(html).toMatch(/<select disabled=""><option value="full" selected="">/);expect(html).not.toContain('설치 때 검사 · 빠른 준비')
 expect(html).toContain('파생 모델과 실행 파일의 전체 해시');expect(html).toContain('원본 VoxCPM2 모델의 전체 검사는 기존 PyTorch 실행 모드에서');expect(html).toContain('>GGUF 파생 모델·실행 파일 전체 검사</button>')
 const running=render({...state,modelCheck:{busy:true,error:null}});expect(running).toContain('GGUF 파생 모델·실행 파일 전체 검사 중');expect(running).toContain('<button>검사 중단</button>')
 const done=render({...state,modelCheck:{busy:false,error:null,completedAt:1}});expect(done).toContain('GGUF 파생 모델·실행 파일 전체 검사 완료')
})
it.each(['gguf-metal-f16','gguf-metal-f16-complete','cuda-compiled','cuda-compiled-complete'] as const)('existing %s connection and preparation UI remains distinct',executionProfile=>{
 const html=render({...state,availableProfiles:[executionProfile],executionProfile})
 expect(html).not.toContain('VoxCPM2 Windows GGUF 실행 환경 연결');expect(html).not.toContain('GGUF 파생 모델·실행 파일 전체 검사</button>');expect(html).toContain('>TTS 런타임·모델 연결</button>')
 if(executionProfile.startsWith('gguf-metal'))expect(html).toContain('처음 사용할 때 실행용 음성을 준비하고')
})
it.each([
 ['VOX_GGUF_RUNTIME_MISSING','F16 파생 모델과 승인 기록을 연결'],
 ['VOX_GGUF_BUILD_PENDING','검증된 실행 파일과 승인 기록'],
 ['VOX_GGUF_DERIVATIVE_UNSUPPORTED','선택한 학습팩에 대응하는 검증된 F16 GGUF'],
 ['VOX_GGUF_NATIVE_INIT','고정 F16 모델, EXE·DLL과 GPU 실행 환경'],
 ['VOX_GGUF_RUNTIME_CONFIG','F16 파생 모델과 승인 기록을 연결'],
 ['VOX_GGUF_TRAINED_IDENTITY','학습팩과 F16 GGUF 변환 기록이 호환되지 않습니다.'],
 ['RUNTIME_RECEIPT','실행 환경과 승인 기록이 일치하지 않습니다.'],
 ['RUNTIME_SOURCE_CHANGED','검증된 EXE·DLL 폴더'],
 ['LORA_INCOMPLETE','학습팩과 F16 GGUF 변환 기록이 호환되지 않습니다.']
])('%s gives Windows GGUF-specific setup guidance', (error,message)=>expect(render({...state,error})).toContain(message))
it('Windows receipt guidance does not replace the existing Mac receipt message',()=>{
 expect(render({...state,executionProfile:'gguf-metal-f16',error:'RUNTIME_RECEIPT'})).toContain('Mac 음성 런타임의 설치 영수증');expect(render({...state,executionProfile:'gguf-cuda-f16',error:'RUNTIME_RECEIPT'})).not.toContain('Mac 음성 런타임의 설치 영수증')
})
it('Vox GGUF setup, provenance and verification guidance has English translations',()=>{
 for(const key of ['VoxCPM2 Windows GGUF 실행 환경 연결','VoxCPM2 Windows GGUF 런타임 다시 연결','VoxCPM2 GGUF CUDA · 청크 재생','VoxCPM2 GGUF Vulkan · 완성 후 재생','이 경로는 VoxCPM2 학습팩의 LoRA를 반영한 F16 GGUF를 재사용합니다. Qwen의 WAV 기준 복제와 달리 학습 가중치가 유지됩니다.','GGUF 준비와 모델 검사에서 파생 모델과 실행 파일의 전체 해시를 확인합니다. 원본 VoxCPM2 모델의 전체 검사는 기존 PyTorch 실행 모드에서 사용할 수 있습니다.','GGUF 파생 모델·실행 파일 전체 검사'])expect(ENGLISH_MESSAGES[key]).toBeTruthy()
})
