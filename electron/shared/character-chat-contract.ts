import type {WindowDragRequest,WindowDragReply} from './window-drag'
import type {CharacterChatDefinition,ChatMeaning,ChatPhase} from './character-chat-semantics'
import type { CharacterEntry } from './character-pack-contract'
export type LocalModelId = 'E4B' | '12B'
export const LOCAL_CHAT_IPC = { action:'character-chat.action', changed:'character-chat.changed', presentation:'character-chat.presentation', getPresentation:'character-chat.get-presentation',gesture:'character-chat.gesture' } as const
export type GenerationBinding={conversationId:string;characterId:string;revision:string;personaHash:string;semanticHash:string;modelId:LocalModelId;requestId:string;epoch:number}
export type ChatMessage = {id:string;role:'user'|'assistant';text:string;status:'complete'|'streaming'|'stopped'|'error';createdAt:string;binding?:GenerationBinding;semanticDiagnostics?:string[]}
export type ChatConversation = {id:string;characterId:string;title:string;messages:ChatMessage[];updatedAt:string;summary?:{text:string;algorithm:'extractive-v1';throughMessageId?:string}}
export type LocalChatSnapshot = {epoch:number;phase:'idle'|'attentive'|'loading'|'generating'|'replying';model:LocalModelId;character:CharacterEntry|null;displayName?:string;characters:CharacterEntry[];conversation:ChatConversation|null;conversations:Array<{id:string;title:string;characterId:string}>;installed:LocalModelId[];error:string|null;download:{model:LocalModelId;bytes:number;total:number}|null;runtimeAvailable:boolean;runtimeIssue?:string;memories?:Array<{id:string;text:string}>;contextNotice?:string;semanticWarning?:string;meaning?:ChatMeaning|null}
export type LocalChatAction = {type:'layout-reset'}|{type:'attention';active:boolean}|{type:'snapshot'}|{type:'send';text:string}|{type:'stop'}|{type:'retry'}|{type:'new'}|{type:'delete';id:string}|{type:'conversation';id:string}|{type:'character';id:string}|{type:'model';id:LocalModelId}|{type:'download';id:LocalModelId}|{type:'cancel-download'}|{type:'import-model';id:LocalModelId}|{type:'remove-model';id:LocalModelId}|{type:'import-pack'}|{type:'codex-mode'}|{type:'memory-save';id?:string;text:string}|{type:'memory-delete';id:string}
export interface LocalChatApi {gesture(kind:"move"|"resize",request:WindowDragRequest):Promise<WindowDragReply>;action(value:LocalChatAction):Promise<LocalChatSnapshot>;subscribe(listener:(state:LocalChatSnapshot)=>void):()=>void}

export type LocalChatPresentation={active:boolean;epoch:number;characterId:string|null;revision:string|null;phase:ChatPhase;definition:CharacterChatDefinition;meaning:ChatMeaning|null}
