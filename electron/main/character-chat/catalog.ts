import type { LocalModelId } from '../../shared/character-chat-contract'
export const CHAT_MODELS:Record<LocalModelId,{repo:string;revision:string;filename:string;bytes:number;sha256:string}>= {
 E4B:{repo:'google/gemma-4-E4B-it-qat-q4_0-gguf',revision:'4b4a2c1d584be7264f87aac328a1bc739ce81b6c',filename:'gemma-4-E4B_q4_0-it.gguf',bytes:5154941280,sha256:'676c35070db6dbe52f93e9c864ee0fba4eddea94b9c875d9cb10daff453fbaee'},
 '12B':{repo:'google/gemma-4-12B-it-qat-q4_0-gguf',revision:'29d097773436b69ff9feafd636ab4cf873786537',filename:'gemma-4-12b-it-qat-q4_0.gguf',bytes:6975879296,sha256:'93567e57a8fe10b23569b9d9ec38cd005deedf71e29477c421a4b83f418a538b'},
}
export const CHAT_RUNTIME_COMMIT='391fac16460f15233a7740550d858ac96df3419d'
export const CHAT_SETTINGS={context:8192,maxTokens:512,reserve:256,checkpoints:1,temperature:1,top_p:.95,top_k:64,min_p:0,repeat_penalty:1,presence_penalty:0,frequency_penalty:0,reasoning_budget_tokens:0} as const
