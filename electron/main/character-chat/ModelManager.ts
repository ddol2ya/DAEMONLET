import {streamChunks} from './stream'
import {createReadStream,constants} from 'node:fs'
import {mkdir,stat,statfs,copyFile,rename,rm,open} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {join} from 'node:path'
import {CHAT_MODELS} from './catalog'
import type {LocalModelId} from '../../shared/character-chat-contract'
export async function digestFile(path:string,signal?:AbortSignal){const hash=createHash('sha256');for await(const chunk of createReadStream(path)){signal?.throwIfAborted();hash.update(chunk)}return hash.digest('hex')}
export class ModelManager {
 private controller:AbortController|null=null
 private operation:Promise<void>|null=null
 private verified=new Map<LocalModelId,{mtime:number;size:number}>()
 constructor(readonly root:string,private readonly progress:(value:{model:LocalModelId;bytes:number;total:number}|null)=>void,private readonly options:{catalog?:typeof CHAT_MODELS;fetch?:typeof fetch;freeBytes?:()=>Promise<number>}={}){}
 private get catalog(){return this.options.catalog??CHAT_MODELS}
 path(id:LocalModelId){return join(this.root,this.catalog[id].filename)}
 async installed(){const ids:LocalModelId[]=[];for(const id of ['E4B','12B'] as const)try{if((await stat(this.path(id))).size===this.catalog[id].bytes)ids.push(id)}catch{}return ids}
 async verify(id:LocalModelId,signal?:AbortSignal){const s=await stat(this.path(id)),old=this.verified.get(id);if(s.size!==this.catalog[id].bytes)throw Error('모델 파일 크기가 맞지 않습니다.');if(old?.mtime!==s.mtimeMs||old.size!==s.size){if(await digestFile(this.path(id),signal)!==this.catalog[id].sha256)throw Error('모델 무결성 검사 실패. 파일을 다시 설치해 주세요.');this.verified.set(id,{mtime:s.mtimeMs,size:s.size})}return this.path(id)}
 private async space(bytes:number){await mkdir(this.root,{recursive:true,mode:0o700});const s=await statfs(this.root);const free=this.options.freeBytes?await this.options.freeBytes():s.bavail*s.bsize;if(free<bytes+256*1024**2)throw Error('모델 설치를 위한 디스크 공간이 부족합니다.')}
 async importFile(id:LocalModelId,source:string){if(this.operation)throw Error('모델 설치가 진행 중입니다.');const controller=this.controller=new AbortController();this.operation=(async()=>{await this.space(this.catalog[id].bytes);this.progress({model:id,bytes:0,total:this.catalog[id].bytes});const target=this.path(id)+'.import';try{if((await stat(source)).size!==this.catalog[id].bytes)throw Error('선택한 모델의 공식 GGUF 파일이 아닙니다.');controller.signal.throwIfAborted();await copyFile(source,target,constants.COPYFILE_FICLONE);controller.signal.throwIfAborted();if(await digestFile(target,controller.signal)!==this.catalog[id].sha256)throw Error('모델 SHA-256이 일치하지 않습니다.');controller.signal.throwIfAborted();await rename(target,this.path(id));this.verified.delete(id)}finally{await rm(target,{force:true})}})();try{await this.operation}finally{this.operation=null;this.controller=null;this.progress(null)}}
 async download(id:LocalModelId){if(this.operation)throw Error('모델 설치가 진행 중입니다.');this.controller=new AbortController();const signal=this.controller.signal;this.operation=this.fetchModel(id,signal);try{await this.operation}finally{this.operation=null;this.controller=null;this.progress(null)}}
 private async fetchModel(id:LocalModelId,signal:AbortSignal){const model=this.catalog[id],partial=this.path(id)+'.partial';let offset=await stat(partial).then(s=>s.size,()=>0);if(offset>model.bytes){await rm(partial);offset=0}await this.space(model.bytes-offset);this.progress({model:id,bytes:offset,total:model.bytes});
  if(offset<model.bytes){const response=await (this.options.fetch??fetch)(`https://huggingface.co/${model.repo}/resolve/${model.revision}/${model.filename}`,{headers:offset?{Range:`bytes=${offset}-`}:{},signal});if(response.status===401||response.status===403)throw Error('모델 접근 조건을 확인해 주세요. 접근 동의를 우회하지 않습니다.');if(!response.ok||!response.body)throw Error('모델 다운로드에 실패했습니다. 다시 시도하면 이어받습니다.');if(response.status===206&&!response.headers.get('content-range')?.startsWith(`bytes ${offset}-`))throw Error('이어받기 범위가 일치하지 않습니다.');if(response.status===200)offset=0;const file=await open(partial,offset?'a':'w',0o600);try{for await(const chunk of streamChunks(response.body)){signal.throwIfAborted();if(offset+chunk.length>model.bytes)throw Error('모델 파일 크기 초과');await file.writeFile(chunk);offset+=chunk.length;this.progress({model:id,bytes:offset,total:model.bytes})}await file.sync()}finally{await file.close()}}
  signal.throwIfAborted();if(offset!==model.bytes||await digestFile(partial,signal)!==model.sha256){await rm(partial,{force:true});throw Error('모델 파일 검증에 실패했습니다. 다시 다운로드해 주세요.')}signal.throwIfAborted();await rename(partial,this.path(id));this.verified.delete(id)
 }
 async cancel(){this.controller?.abort();await this.operation?.catch(()=>{})}
 async remove(id:LocalModelId){if(this.operation)throw Error('설치를 먼저 중단해 주세요.');await rm(this.path(id),{force:true});await rm(this.path(id)+'.partial',{force:true});this.verified.delete(id)}
}
