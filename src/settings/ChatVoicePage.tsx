import {useEffect,useRef,useState} from 'react'
import {useT} from '../i18n/useLanguage'
import type {GpuBackendPreference} from '../../electron/shared/gpu-backend'
import {VoiceSettings} from '../character-chat/VoiceControls'
import type {VoiceAction} from '../../electron/shared/character-voice-contract'
import type {ChatManagementAction,ChatSettingsApi,ChatSettingsSnapshot,VoiceManagementAction} from '../../electron/shared/chat-settings-contract'
declare global{interface Window{chatSettings:ChatSettingsApi}}
export function ChatVoicePage({manageCharacters}:{manageCharacters:()=>void}){
 const t=useT(),api=window.chatSettings,operation=useRef(false)
 const [state,setState]=useState<ChatSettingsSnapshot|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[memory,setMemory]=useState(''),[memoryId,setMemoryId]=useState<string>()
 const receive=(s:ChatSettingsSnapshot)=>setState(old=>old&&old.revision>s.revision?old:s)
 useEffect(()=>{let active=true;const accept=(s:ChatSettingsSnapshot)=>{if(active)receive(s)};const off=api?.subscribe(accept);void api?.action({type:'snapshot'}).then(accept).catch(()=>{if(active)setError('대화 설정을 불러오지 못했습니다.')});return()=>{active=false;off?.()}},[api])
 useEffect(()=>{setMemory('');setMemoryId(undefined)},[state?.context.characterId,state?.context.revision])
 const run=async(task:()=>Promise<ChatSettingsSnapshot>,interrupt=false)=>{if(operation.current&&!interrupt)return false;setError('');if(!interrupt){operation.current=true;setBusy(true)};try{receive(await task());return true}catch(e){const message=String(e);setError(message.includes('CONTEXT_CHANGED')?'캐릭터나 대화가 바뀌었습니다. 현재 선택을 확인해 주세요.':message.includes('VOICE_OUTPUT_NOT_READY')?'캐릭터챗을 연 뒤 다시 시험해 주세요.':'설정을 적용하지 못했습니다. 현재 상태를 확인하고 다시 시도해 주세요.');return false}finally{if(!interrupt){operation.current=false;setBusy(false)}}}
 const chat=(action:ChatManagementAction)=>state&&run(()=>api.action({type:'chat',action,context:state.context}),action.type==='cancel-download')
 const voice=(action:VoiceAction)=>state&&run(()=>api.action({type:'voice',action:action as VoiceManagementAction,context:state.context}),['cancelPrepareVoiceFiles','cancelModelCheck','stop','cancelInstallBase','cancelInstallQwen','cancelInstallGgufModel','cancelInstallGgufRuntime','cancelReferenceImport','volume'].includes(action.type))
 if(!state)return <div className="empty-state" role="status">{t(error||'설정 불러오는 중…')}</div>
 const c=state.chat,installed=c.installed.includes(c.model),generating=['loading','generating','replying'].includes(c.phase)
 return <div className="chat-settings-page">
  <header className="page-header"><div><h1>{t('대화·음성')}</h1><p>{t('로컬 모델과 캐릭터의 목소리를 한곳에서 관리하세요.')}</p></div><button className="button secondary" onClick={()=>void run(()=>api.action({type:'open-chat'}))}>{t('로컬 캐릭터 대화 열기')}</button></header>
  <div className="chat-settings-context"><span className="status-dot positive"/><strong>{c.displayName||c.character?.name||t('캐릭터 선택 필요')}</strong><span>{t('선택된 캐릭터')}</span><button className="text-button" onClick={manageCharacters}>{t('캐릭터팩 관리')}</button></div>
  {error&&<div className="notice error" role="alert">{t(error)}</div>}
  <section className="section-card"><div className="section-heading"><div><h2>{t('캐릭터 음성')}</h2><p>{t('엔진과 필요한 파일을 준비한 뒤 목소리를 선택하고 시험해 보세요.')}</p></div></div><fieldset className="chat-settings-fields" aria-busy={busy}><VoiceSettings state={state.voice} characterId={c.character?.id} act={voice} playbackReady={state.playbackReady} busy={busy}/></fieldset></section>
  <section className="section-card"><div className="section-heading"><div><h2>{t('로컬 대화 모델')}</h2><p>{t('한 번 준비하면 오프라인으로 대화할 수 있어요.')}</p></div><span className="chat-settings-badge">{t(installed?'설치됨':'설치 필요')}</span></div>
   <label className="chat-settings-field">{t('대화 모델')}<select aria-label={t('대화 모델')} value={c.model} disabled={busy||!!c.download} onChange={e=>void chat({type:'model',id:e.target.value as 'E4B'|'12B'})}><option value="E4B">Gemma 4 E4B · 5.2 GB</option><option value="12B">Gemma 4 12B · 7.0 GB</option></select></label>
   {(c.availableGpuBackends?.length??0)>1&&<label className="chat-settings-field">{t('대화 GPU 실행 방식')}<select aria-label={t('대화 GPU 실행 방식')} value={c.gpuBackend??'auto'} disabled={busy||!!c.download} onChange={e=>void chat({type:'gpu-backend',value:e.target.value as GpuBackendPreference})}><option value="auto">{t('자동 (권장)')}</option><option value="cuda">NVIDIA CUDA</option><option value="vulkan">Vulkan</option></select></label>}
   {c.runtimeDevice&&<p role="status">{t('선택된 실행 환경')}: {c.runtimeDevice.backend} · {c.runtimeDevice.name}</p>}
   {c.runtimeFallback&&<p role="status">{t('CUDA를 사용할 수 없어 Vulkan으로 실행했습니다.')}</p>}
   {c.runtimeIssue&&<p role="status">{t(c.runtimeIssue)}</p>}
   <div className="button-row">{!installed?<><button className="button primary" disabled={busy||!!c.download} onClick={()=>void chat({type:'download',id:c.model})}>{t('모델 다운로드')}</button><button className="button secondary" disabled={busy||!!c.download} onClick={()=>void chat({type:'import-model',id:c.model})}>{t('보유한 GGUF 가져오기')}</button></>:<button className="button secondary destructive-text" disabled={busy||!!c.download} onClick={()=>void chat({type:'remove-model',id:c.model})}>{t('모델 삭제')}</button>}</div>
   {c.download&&<div className="chat-settings-progress" role="status"><progress aria-label={t('모델 설치 진행률')} value={c.download.bytes} max={c.download.total}/><span>{Math.floor(c.download.bytes/c.download.total*100)}%</span><button className="button secondary small" onClick={()=>void chat({type:'cancel-download'})}>{t('설치 중단')}</button></div>}
  </section>
  <section className="section-card"><h2>{t('대화 관리')}</h2><p>{c.conversation?.title||t('선택된 대화가 없어요.')}</p><div className="button-row"><button className="button secondary" disabled={busy||!c.character} onClick={()=>void chat({type:'new'})}>{t('새 대화')}</button><button className="button secondary" disabled={busy||generating||!c.conversation?.messageCount} onClick={()=>void chat({type:'retry'})}>{t('다시 답하기')}</button><button className="button secondary destructive-text" disabled={busy||!c.conversation} onClick={()=>c.conversation&&void chat({type:'delete',id:c.conversation.id})}>{t('대화 삭제')}</button><button className="button quiet" disabled={busy} onClick={()=>void chat({type:'layout-reset'})}>{t('말풍선 위치·크기 초기화')}</button></div></section>
  <section className="section-card"><h2>{t('기억')}</h2><p>{t('현재 캐릭터에게만 제공됩니다. 대화 삭제와 별도로 관리해요.')}</p>
   {c.memories?.map(m=><div className="chat-memory" key={m.id}><p>{m.text}</p><div className="button-row"><button className="text-button" disabled={busy} onClick={()=>{setMemory(m.text);setMemoryId(m.id)}}>{t('수정')}</button><button className="text-button destructive-text" disabled={busy} onClick={()=>void chat({type:'memory-delete',id:m.id})}>{t('기억 삭제')}</button></div></div>)}
   <label className="chat-settings-field">{t('저장할 기억')}<textarea aria-label={t('저장할 기억')} value={memory} maxLength={500} disabled={busy||!c.character} onChange={e=>setMemory(e.target.value)}/></label><div className="button-row"><button className="button secondary" disabled={busy||!c.character||!memory.trim()} onClick={async()=>{if(await chat({type:'memory-save',text:memory,id:memoryId})){setMemory('');setMemoryId(undefined)}}}>{t('기억 저장')}</button>{memoryId&&<button className="button quiet" onClick={()=>{setMemory('');setMemoryId(undefined)}}>{t('취소')}</button>}</div>
  </section>
  {(c.error||c.semanticWarning||c.contextNotice)&&<p role="status">{c.error||c.semanticWarning||c.contextNotice}</p>}
 </div>
}
