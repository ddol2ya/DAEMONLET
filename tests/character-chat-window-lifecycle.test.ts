import {afterEach,expect,it,vi} from 'vitest'
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
const environment=vi.hoisted(()=>({root:'',windows:vi.fn(),confirm:vi.fn()}))
vi.mock('electron',()=>({app:{getPath:()=>environment.root,isPackaged:false},BrowserWindow:environment.windows,ipcMain:{handle:vi.fn(),removeHandler:vi.fn()},screen:{},dialog:{showMessageBox:environment.confirm}}))
import {CharacterChatWindow} from '../electron/main/character-chat/CharacterChatWindow'
const roots:string[]=[]
afterEach(async()=>{vi.restoreAllMocks();for(const r of roots.splice(0))await rm(r,{recursive:true,force:true})})
async function fixture(){
 environment.root=await mkdtemp(join(tmpdir(),'chat-window-lifecycle-'));roots.push(environment.root)
 await mkdir(join(environment.root,'character-chat'))
 const hooks={pet:()=>null,reveal:vi.fn(),active:vi.fn(),select:vi.fn(async()=>{}),selected:()=> 'gpichan'}
 const registry={snapshot:()=>({entries:[]})}
 const window=new CharacterChatWindow('/unused',registry as any,undefined,hooks)
 vi.spyOn(window.service.runtime,'stop').mockResolvedValue();vi.spyOn(window.service.models,'cancel').mockResolvedValue()
 return {window,root:join(environment.root,'character-chat')}
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
