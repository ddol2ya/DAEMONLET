import {expect,it} from 'vitest'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {VoiceSettings} from '../src/character-chat/VoiceControls'
import type {VoiceSnapshot} from '../electron/shared/character-voice-contract'
import {ENGLISH_MESSAGES} from '../electron/shared/translations'
const state:VoiceSnapshot={epoch:1,enabled:true,autoRead:true,volume:.5,profiles:[],bindings:{},status:'idle',error:null,runtimeConfigured:true,engine:'qwen3-tts-06b',availableEngines:['voxcpm2','qwen3-tts-06b'],qwenConfigured:true,qwenClone:{mode:'x-vector',transcript:''},availableProfiles:['qwen-mlx','qwen-mlx-complete'],executionProfile:'qwen-mlx'}
it('Mac settings label real incremental Qwen and offer complete decoding separately',()=>{
 const html=renderToStaticMarkup(createElement(VoiceSettings,{state,act:()=>{},playbackReady:true,characterId:'test'}))
 expect(html).toContain('음성 엔진');expect(html).toContain('Qwen MLX · 청크 재생');expect(html).toContain('Qwen MLX · 완성 후 재생');expect(html).toContain('합성 중 생성되는 음성');expect(html).not.toContain('각 구간의 합성이 끝난 뒤 재생합니다.')
})
it('Windows labels only complete waveform and requires exact transcript for ICL',()=>{
 const html=renderToStaticMarkup(createElement(VoiceSettings,{state:{...state,availableProfiles:['qwen-complete'],executionProfile:'qwen-complete',qwenClone:{mode:'icl',transcript:''}},act:()=>{},playbackReady:true,characterId:'test'}))
 expect(html).toContain('Qwen · 완성 후 재생');expect(html).toContain('각 구간의 합성이 끝난 뒤 재생');expect(html).toContain('기준 WAV의 정확한 문장');expect(html).not.toContain('Qwen MLX · 청크 재생')
})

it('Windows preparation policy explains skipped weights and offers an explicit full check',()=>{
 const html=renderToStaticMarkup(createElement(VoiceSettings,{state:{...state,modelVerification:'installed',availableProfiles:['qwen-complete'],executionProfile:'qwen-complete'},act:()=>{},playbackReady:true}))
 expect(html).toContain('설치 때 검사 · 빠른 준비');expect(html).toContain('설치 후 손상을 모두 발견하지 못합니다.');expect(html).toContain('모델 전체 검사')
 const mac=renderToStaticMarkup(createElement(VoiceSettings,{state,act:()=>{},playbackReady:true}));expect(mac).not.toContain('모델 준비 검사')
})
it('a running full check shows cancellation and disables engine controls',()=>{
 const html=renderToStaticMarkup(createElement(VoiceSettings,{state:{...state,modelVerification:'full',modelCheck:{busy:true,error:null}},act:()=>{},playbackReady:true}))
 expect(html).toContain('모델 전체 검사 중');expect(html).toContain('검사 중단');expect(html).toMatch(/<input type="radio" disabled="" name="voice-engine-path"/)
})

it('a damaged managed Vox model offers user-initiated repair rather than a disabled installed button',()=>{
 const html=renderToStaticMarkup(createElement(VoiceSettings,{state:{...state,engine:'voxcpm2',modelVerification:'installed',baseInstall:{supported:true,installed:false,phase:'idle',bytes:0,total:1,error:'VOICE_BASE_CHANGED'},modelCheck:{busy:false,error:'VOICE_MODEL_CHECK_FAILED'}},act:()=>{},playbackReady:true}))
 expect(html).toContain('기본 음성 복구 설치');expect(html).not.toContain('>기본 음성 설치됨</button>')
})

const managed={supported:true,installed:false,repairNeeded:false,phase:'idle' as const,bytes:0,total:1862240384,error:null,model:'mlx-community/Qwen3-TTS-12Hz-0.6B-Base-4bit',modelBytes:1711328624,runtimeBytes:150911760,minimumFreeBytes:8*1024**3,communityConversion:true,license:'Apache-2.0'}
it('Qwen install clearly includes runtime/conversion/space and hides all Vox installation and connection controls',()=>{
 const html=renderToStaticMarkup(createElement(VoiceSettings,{state:{...state,qwenConfigured:false,qwenInstall:managed,baseInstall:{supported:true,installed:false,phase:'idle',bytes:0,total:1,error:null}},act:()=>{},playbackReady:false}))
 for(const text of ['Qwen 다운로드·설치 후 적용','mlx-community MLX 4bit','1.71 GB','0.15 GB','1.86 GB','8 GiB','Python·MLX','말하거나 대화를 열지 않습니다.','WAV 기준 음성'])expect(html).toContain(text)
 expect(html).not.toContain('>TTS 런타임·모델 연결</button>');expect(html).not.toContain('>기본 음성 설치</button>')
})
it.each(['preparing','downloading','installing','verifying','applying'] as const)('Qwen phase %s shows a live status and interruptible cancellation even during a pending page action',phase=>{
 const html=renderToStaticMarkup(createElement(VoiceSettings,{state:{...state,qwenInstall:{...managed,phase,bytes:managed.total/2}},act:()=>{},playbackReady:false,busy:true}))
 expect(html).toContain('aria-live="polite"');expect(html).toContain('<button>Qwen 설치 중단</button>');expect(html).toMatch(/<input type="radio" disabled="" name="voice-engine-path"/);expect(html).not.toContain('>Qwen 다운로드·설치 후 적용</button>')
 if(phase==='downloading')expect(html).toContain('50%');else expect(html).not.toContain('50%')
})
it('installed, repair, retry and deferred registration offer the correct explicit operation',()=>{
 for(const [install,label] of [[{...managed,installed:true},'설치된 Qwen 적용'],[{...managed,repairNeeded:true,error:'QWEN_INSTALL_CHANGED'},'Qwen 복구 설치 후 적용'],[{...managed,error:'VOICE_DOWNLOAD_FAILED'},'Qwen 설치 다시 시도'],[{...managed,installed:true,applicationDeferred:true},'현재 설정을 유지했습니다.']] as const){
  const html=renderToStaticMarkup(createElement(VoiceSettings,{state:{...state,qwenInstall:install},act:()=>{},playbackReady:false}));expect(html).toContain(label)
 }
 const windows=renderToStaticMarkup(createElement(VoiceSettings,{state:{...state,qwenInstall:{...managed,communityConversion:false,model:'Qwen/Qwen3-TTS-12Hz-0.6B-Base',modelBytes:2516106051,runtimeBytes:3695031909,total:6211137960,minimumFreeBytes:30*1024**3}},act:()=>{},playbackReady:false}));expect(windows).toContain('Qwen 공식 원본');expect(windows).toContain('6.21 GB');expect(windows).toContain('30 GiB');expect(windows).toContain('PyTorch CUDA')
})

it('Vox shows only its selected files while an outstanding Qwen download retains cancellation',()=>{
 for(const install of [managed,{...managed,error:'VOICE_DOWNLOAD_FAILED'},{...managed,installed:true,applicationDeferred:true},{...managed,phase:'downloading' as const}]){
  const html=renderToStaticMarkup(createElement(VoiceSettings,{state:{...state,engine:'voxcpm2',executionProfile:'gguf-metal-f16',qwenConfigured:false,qwenInstall:install},act:()=>{},playbackReady:false}))
  expect(html).toMatch(/<input(?=[^>]*value="vox-metal")(?=[^>]*checked="")[^>]*>/)
  if(install.phase==='downloading'){expect(html).toContain('Qwen 다운로드 및 설치');expect(html).toContain('Qwen 설치 중단')}
  else expect(html).not.toContain('Qwen 다운로드 및 설치')
 }
})

const gguf:VoiceSnapshot={...state,platform:'win32',arch:'x64',engine:'qwen3-tts-06b-gguf',availableEngines:['voxcpm2','qwen3-tts-06b','qwen3-tts-06b-gguf'],qwenGgufConfigured:false,qwenInstall:managed,modelVerification:'installed',availableProfiles:['qwen-gguf','qwen-gguf-complete'],executionProfile:'qwen-gguf'}
it('GGUF is separately selectable with manual setup and no PyTorch installation action',()=>{
 const html=renderToStaticMarkup(createElement(VoiceSettings,{state:gguf,act:()=>{},playbackReady:true,characterId:'test'}))
 expect(html).toMatch(/<input(?=[^>]*value="qwen-gguf")(?=[^>]*checked="")[^>]*>/)
 for(const text of ['Base Q8','Qwen GGUF Python·DLL·모델 연결','보유한 GGUF 실행 환경 수동 연결','CUDA SDK나 새 GPU 드라이버를 설치하지 않습니다.','R580 이상 NVIDIA 드라이버','커뮤니티 MIT','Apache-2.0','Qwen GGUF CUDA · 청크 재생','Qwen GGUF CUDA · 완성 후 재생'])expect(html).toContain(text)
 expect(html).not.toContain('Qwen 다운로드 및 설치');expect(html).not.toContain('Qwen 다운로드·설치 후 적용');expect(html).not.toContain('Qwen MLX · 청크 재생')
 expect(html).not.toContain('Qwen GGUF 런타임 다시 연결') // An existing PyTorch connection does not configure GGUF.
 const connected=renderToStaticMarkup(createElement(VoiceSettings,{state:{...gguf,qwenGgufConfigured:true},act:()=>{},playbackReady:true}));expect(connected).toContain('Qwen GGUF 런타임 다시 연결')
 const mac=renderToStaticMarkup(createElement(VoiceSettings,{state,act:()=>{},playbackReady:true}));expect(mac).not.toContain('value="qwen-gguf"')
})
it('GGUF always presents full model verification while the PyTorch policy remains available',()=>{
 const html=renderToStaticMarkup(createElement(VoiceSettings,{state:gguf,act:()=>{},playbackReady:true}))
 expect(html).toContain('모델 준비 검사');expect(html).toMatch(/<select disabled=""><option value="full" selected="">/);expect(html).toContain('Base와 codec 모델 파일 전체를 검사');expect(html).not.toContain('설치 때 검사 · 빠른 준비');expect(html).toContain('모델 전체 검사')
})
it('both Qwen engines retain WAV and ICL controls but disable trained LoRA and default profiles',()=>{
 for(const engine of ['qwen3-tts-06b','qwen3-tts-06b-gguf'] as const){
  const profiles:VoiceSnapshot['profiles']=[{id:'trained',version:'1',name:'Trained voice',fingerprint:'a',adapterSha256:'b'},{id:'wav-reference',version:'1',name:'Reference',kind:'wav-reference',fingerprint:'c',referenceSha256:'d',reference:{durationMs:5000,sampleRate:48000,channels:1,encoding:'pcm16',samples:240000,bytes:480044}},{id:'default',version:'1',name:'Default',kind:'base-default',adapterSha256:'none',fingerprint:'e'}]
  const html=renderToStaticMarkup(createElement(VoiceSettings,{state:{...gguf,engine,profiles,bindings:{test:'trained@1'},qwenClone:{mode:'icl',transcript:''}},act:()=>{},playbackReady:true,characterId:'test'}))
  expect(html).toMatch(/<option disabled="" value="trained@1" selected="">/);expect(html).toMatch(/<option disabled="" value="default@1">/);expect(html).toMatch(/<option value="wav-reference@1">/)
  expect(html).toContain('LoRA 가중치는 적용되지 않습니다.');expect(html).toContain('기존 학습팩은 그대로 보존');expect(html).toContain('기준 WAV의 정확한 문장');expect(html).toContain('Qwen을 준비하려면 WAV 기준 음성을 선택')
 }
})
it('GGUF user-facing setup and compatibility guidance has English translations',()=>{
 for(const key of ['Qwen GGUF Python·DLL·모델 연결','Qwen GGUF 런타임 다시 연결','Qwen GGUF CUDA · 청크 재생','Qwen GGUF CUDA · 완성 후 재생','Qwen은 WAV 기준 음성을 사용합니다. VoxCPM2 학습팩의 LoRA 가중치는 적용되지 않습니다. 기존 학습팩은 그대로 보존됩니다.','현재 CUDA 시험 장치는 Windows x64·RTX 4090입니다. Vulkan과 AMD·Intel GPU의 실행은 아직 검증하지 않았습니다.','Qwen GGUF 환경의 Python 선택','검증된 Qwen GGUF CUDA DLL 폴더 선택','Qwen 0.6B Base Q8·codec Q8 모델 폴더 선택'])expect(ENGLISH_MESSAGES[key]).toBeTruthy()
})
it.each([
 ['QWEN_GGUF_RUNTIME_VERSION','Python 패키지 버전이 맞지 않습니다.'],
 ['QWEN_GGUF_PLATFORM_REQUIRED','Windows x64와 지원되는 NVIDIA CUDA'],
 ['QWEN_GGUF_CUDA_REQUIRED','CUDA 실행을 확인하지 못했습니다.'],
 ['QWEN_GGUF_BASE_REQUIRED','CustomVoice 모델은 사용할 수 없습니다.'],
 ['QWEN_GGUF_RUNTIME_CONFIG','검증된 CUDA DLL과 Base Q8·codec Q8'],
 ['QWEN_GGUF_CAPABILITIES','런타임 버전이 맞지 않습니다.']
])('GGUF diagnostic %s gives actionable setup guidance', (error,message)=>{
 const html=renderToStaticMarkup(createElement(VoiceSettings,{state:{...gguf,error},act:()=>{},playbackReady:true}));expect(html).toContain(message)
})

it('shows Microsoft acceptance only for the managed runtime scope, without preselecting it',()=>{
 const terms={fingerprint:'fixture-fingerprint',accepted:false,error:null,documents:[{id:'vc-test',title:'Microsoft runtime fixture',version:'fixture',files:['vc/msvcp140.dll'],originalSha256:'0'.repeat(64)}],cudaNotice:{id:'cuda-test',title:'CUDA fixture'}}
 const available={id:'qwen-cuda' as const,supported:true,available:true,installed:true,verified:true,phase:'idle' as const,bytes:0,total:1,error:null}
 const html=renderToStaticMarkup(createElement(VoiceSettings,{state:{...gguf,ggufRuntimeTerms:terms,ggufRuntimeInstall:[available]},act:()=>{},playbackReady:true}))
 expect(html).toContain('Microsoft 음성 실행 파일 이용 조건');expect(html).toContain('LGPL 등 각 오픈소스');expect(html).toContain('NVIDIA CUDA 구성요소 안내')
 expect(html).toMatch(/<input type="checkbox"\/>/);expect(html).toContain('<button disabled="">Microsoft 조건 수락</button>');expect(html).toMatch(/<button[^>]*disabled=""[^>]*>필요한 파일 받기·연결<\/button>/)
 const accepted=renderToStaticMarkup(createElement(VoiceSettings,{state:{...gguf,ggufRuntimeTerms:{...terms,accepted:true},ggufRuntimeInstall:[available]},act:()=>{},playbackReady:true}))
 expect(accepted).toContain('이 버전의 Microsoft 음성 실행 파일 이용 조건을 수락했습니다.');expect(accepted).not.toContain('>Microsoft 조건 수락</button>')
 const legacy=renderToStaticMarkup(createElement(VoiceSettings,{state,act:()=>{},playbackReady:true}));expect(legacy).not.toContain('Microsoft 음성 실행 파일 이용 조건')
})
it('offers the existing-file preparation button for managed missing connections',()=>{
 const html=renderToStaticMarkup(createElement(VoiceSettings,{state:{...gguf,error:'QWEN_GGUF_RUNTIME_MISSING',ggufRuntimeInstall:[{id:'qwen-cuda',supported:true,available:true,installed:true,verified:true,phase:'idle',bytes:0,total:1,error:null}]},act:()=>{},playbackReady:true}))
 expect(html).toContain('필요한 파일 받기·연결을 눌러 받은 파일을 검사하고 현재 엔진에 연결해 주세요.')
})
