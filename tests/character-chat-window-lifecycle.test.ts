import {afterEach,expect,it,vi} from 'vitest'
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {EventEmitter} from 'node:events'
import {randomUUID} from 'node:crypto'
import {ConversationStore} from '../electron/main/character-chat/ConversationStore'
const environment=vi.hoisted(()=>({root:'',windows:vi.fn(),confirm:vi.fn()}))
vi.mock('electron',async()=>({app:{getPath:()=>environment.root,isPackaged:false},BrowserWindow:environment.windows,ipcMain:{handle:vi.fn(),removeHandler:vi.fn()},screen:new (await import('node:events')).EventEmitter(),dialog:{showMessageBox:environment.confirm}}))
vi.mock('../electron/main/SecurityPolicy',()=>({secureWebContents:vi.fn(),expectedRendererUrl:()=> 'pet://app/character-chat.html',isTrustedSender:()=>true}))
import {CharacterChatWindow} from '../electron/main/character-chat/CharacterChatWindow'
const roots:string[]=[]
afterEach(async()=>{vi.restoreAllMocks();environment.windows.mockReset();environment.confirm.mockReset();for(const r of roots.splice(0))await rm(r,{recursive:true,force:true})})
async function fixture(){
 environment.root=await mkdtemp(join(tmpdir(),'chat-window-lifecycle-'));roots.push(environment.root)
 await mkdir(join(environment.root,'character-chat'))
 const hooks={pet:()=>null,reveal:vi.fn(),active:vi.fn(),select:vi.fn(async()=>{}),selected:vi.fn(()=> 'gpichan')}
 const entries=['gpichan','synthetic-b'].map(id=>({id,name:id,revision:'revision-'+id,status:'ready'}))
 const registry={snapshot:()=>({entries}),get:(id:string)=>entries.find(e=>e.id===id),ensureReady:async(e:unknown)=>e,readPersonaAsset:async(e:{id:string})=>Buffer.from(JSON.stringify({schemaVersion:1,id:e.id,label:e.id,base:{source:'source.png',psd:'model.psd'},poses:[]}))}
 const window=new CharacterChatWindow('/unused',registry as any,undefined,hooks)
 vi.spyOn(window.service.runtime,'stop').mockResolvedValue();vi.spyOn(window.service.models,'cancel').mockResolvedValue()
 vi.spyOn(window.service.models,'installed').mockResolvedValue(['E4B']);vi.spyOn(window.service.runtime,'available').mockResolvedValue(true)
 return {window,root:join(environment.root,'character-chat'),registry,hooks}
}
it('F1: unopened repeated dispose shares cleanup and leaves stored chat/layout untouched',async()=>{
 const {window,root}=await fixture();for(const name of ['conversations.json','window-layout.json'])await writeFile(join(root,name),'preserve exact bytes')
 const a=window.dispose(),b=window.dispose();expect(a).toBe(b);await a
 for(const name of ['conversations.json','window-layout.json'])expect(await readFile(join(root,name),'utf8')).toBe('preserve exact bytes')
 expect(window.service.runtime.stop).toHaveBeenCalledTimes(1)
})
it('F1: dispose overlapping open waits and never creates a window after shutdown',async()=>{
 const {window,root}=await fixture();await writeFile(join(root,'window-layout.json'),'keep original')
 let release!:()=>void;const gate=new Promise<void>(r=>{release=r})
 vi.spyOn(window.service,'initialize').mockImplementation(()=>gate)
 const opened=window.open(),closed=window.dispose();release();await Promise.all([opened,closed])
 expect(environment.windows).not.toHaveBeenCalled();expect(await readFile(join(root,'window-layout.json'),'utf8')).toBe('keep original')
})

it.each([0,1])('conversation deletion uses native confirmation and honors answer %s',async response=>{
 const {window}=await fixture();const win={isDestroyed:()=>false};window.window=win as any
 const snapshot=window.service.snapshot();snapshot.character={id:'test'} as any;snapshot.conversations=[{id:'target',characterId:'test',title:'새 대화'}]
 vi.spyOn(window.service,'snapshot').mockReturnValue(snapshot)
 const remove=vi.spyOn(window.service,'deleteConversation').mockResolvedValue()
 environment.confirm.mockResolvedValue({response})
 await (window as any).action({type:'delete',id:'target'})
 expect(environment.confirm).toHaveBeenLastCalledWith(win,expect.objectContaining({buttons:['취소','삭제'],defaultId:0,cancelId:0}))
 expect(remove).toHaveBeenCalledTimes(response===1?1:0)
})
it('a closed window cannot apply a delayed deletion confirmation',async()=>{
 const {window}=await fixture();window.window={isDestroyed:()=>false} as any
 const snapshot=window.service.snapshot();snapshot.character={id:'test'} as any;snapshot.conversations=[{id:'target',characterId:'test',title:'새 대화'}]
 vi.spyOn(window.service,'snapshot').mockReturnValue(snapshot);const remove=vi.spyOn(window.service,'deleteConversation').mockResolvedValue()
 let resolve!:(v:{response:number})=>void;environment.confirm.mockImplementation(()=>new Promise(r=>{resolve=r}))
 const pending=(window as any).action({type:'delete',id:'target'});window.window=null;resolve({response:1});await pending;expect(remove).not.toHaveBeenCalled()
})

function mockWindows(){
 environment.windows.mockImplementation(function(){
  const win=new EventEmitter() as any
  let dead=false
  win.webContents=new EventEmitter();win.webContents.send=vi.fn()
  win.isDestroyed=()=>dead;win.show=vi.fn();win.focus=vi.fn();win.loadURL=vi.fn(async()=>{})
  win.destroy=()=>{dead=true;win.emit('closed')};win.close=win.destroy
  return win
 })
}
async function savedFixture(){
 const f=await fixture(),id=randomUUID();const data={version:2 as const,model:'E4B' as const,characterId:'gpichan',current:id,conversations:[{id,characterId:'gpichan',title:'kept',messages:[],updatedAt:new Date().toISOString()}],memories:{gpichan:[{id:randomUUID(),text:'kept memory'}]}}
 const store=new ConversationStore(f.root);await store.save(data);return {...f,store,data}
}
it('R1: transient persona failure recovers through the same window open with latest selected character',async()=>{
 const {window,registry,hooks,store}=await savedFixture();mockWindows();const before=await readFile(store.file)
 vi.spyOn(registry,'readPersonaAsset').mockRejectedValueOnce(Error('temporary persona'))
 await expect(window.open()).rejects.toThrow('temporary persona');expect(environment.windows).not.toHaveBeenCalled()
 hooks.selected.mockReturnValue('synthetic-b');registry.get('synthetic-b')!.revision='latest'
 await window.open();expect(environment.windows).toHaveBeenCalledTimes(1);expect(window.service.snapshot().character?.id).toBe('synthetic-b');expect(window.service.snapshot().character?.revision).toBe('latest');expect((await readFile(store.file)).equals(before)).toBe(true)
 await window.dispose()
})
it('R1: layout-only failure retries layout but never reloads or resets a loaded service',async()=>{
 const {window,store,data}=await savedFixture();mockWindows()
 const serviceStore=(window.service as any).store as ConversationStore,load=vi.spyOn(serviceStore,'load')
 const layout=vi.spyOn((window as any).layout,'load').mockRejectedValueOnce(Error('temporary layout'))
 await expect(window.open()).rejects.toThrow('temporary layout');expect(window.service.snapshot().memories).toEqual(data.memories.gpichan)
 await window.open();expect(layout).toHaveBeenCalledTimes(2);expect(load).toHaveBeenCalledTimes(1);expect((await store.load()).value).toEqual(data);await window.dispose()
})
it('R1: overlapping opens share preparation and create only one window',async()=>{
 const {window}=await savedFixture();mockWindows();const store=(window.service as any).store as ConversationStore,read=store.load.bind(store)
 let release!:()=>void;const gate=new Promise<void>(r=>{release=r})
 const load=vi.spyOn(store,'load').mockImplementation(async()=>{await gate;return read()});const layout=vi.spyOn((window as any).layout,'load')
 const a=window.open(),b=window.open();release();await Promise.all([a,b]);expect(load).toHaveBeenCalledTimes(1);expect(layout).toHaveBeenCalledTimes(1);expect(environment.windows).toHaveBeenCalledTimes(1);await window.dispose()
})
it('R1: failed service waits for pending layout before another attempt; dispose forbids late opens',async()=>{
 const {window,registry,store}=await savedFixture();mockWindows();const before=await readFile(store.file)
 let release!:()=>void;const gate=new Promise<void>(r=>{release=r})
 const read=vi.spyOn(registry,'readPersonaAsset').mockRejectedValueOnce(Error('temporary'))
 const layout=vi.spyOn((window as any).layout,'load').mockImplementationOnce(()=>gate)
 const a=window.open(),b=window.open();const results=Promise.allSettled([a,b]);await vi.waitFor(()=>expect(read).toHaveBeenCalledTimes(1));expect(layout).toHaveBeenCalledTimes(1)
 const disposed=window.dispose();release();await disposed;expect((await results).every(r=>r.status==='rejected')).toBe(true)
 await window.open();await expect(window.service.initialize()).rejects.toThrow('종료');expect(environment.windows).not.toHaveBeenCalled();expect((await readFile(store.file)).equals(before)).toBe(true)
})
it('R2: closing the bubble cancels an accepted queued send before runtime startup',async()=>{
 const {window}=await savedFixture();mockWindows();await window.open()
 const start=vi.spyOn(window.service.runtime,'start'),verify=vi.spyOn(window.service.models,'verify'),generate=vi.spyOn(window.service.runtime,'generate')
 const send=window.service.send('queued');window.window!.close();await send;await (window.service as any).serial
 expect(verify).not.toHaveBeenCalled();expect(start).not.toHaveBeenCalled();expect(generate).not.toHaveBeenCalled();expect(window.service.snapshot().phase).toBe('idle');await window.dispose()
})
