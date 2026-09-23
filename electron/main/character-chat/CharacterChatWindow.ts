import {NativeDragStart} from '../NativeDragStart'
import {WindowDragController} from '../WindowDragController'
import {validWindowDragRequest} from '../../shared/window-drag'
import type {EventEmitter} from 'node:events'
import {positionActivityBubble} from '../../shared/activity-bubble'
import {bubblePlacementReference,positionRelativeBubble} from '../../shared/bubble-placement'
import {ChatWindowLayout,CHAT_WINDOW_MIN,CHAT_WINDOW_MAX,resizeChatBounds} from './ChatWindowLayout'
import type {CharacterEntry} from '../../shared/character-pack-contract'
import type {LocalChatPresentation} from '../../shared/character-chat-contract'
import {app,BrowserWindow,dialog,ipcMain,screen} from 'electron'
import {join} from 'node:path'
import {expectedRendererUrl,isTrustedSender,secureWebContents} from '../SecurityPolicy'
import {LOCAL_CHAT_IPC,type LocalChatAction} from '../../shared/character-chat-contract'
import type {CharacterRegistry} from '../CharacterRegistry'
import {CharacterChatService} from './CharacterChatService'
export class CharacterChatWindow {
 window:BrowserWindow|null=null;readonly service:CharacterChatService;private initialized:Promise<void>|null=null;private disposing:Promise<void>|null=null;private disposed=false;private importing=false;private detach:(()=>void)|null=null
 constructor(private dirname:string,private registry:CharacterRegistry,private devServerUrl:string|undefined,private hooks:{pet:()=>BrowserWindow|null;reveal:()=>void;active:(value:boolean)=>void;select:(entry:CharacterEntry)=>Promise<void>;selected:()=>string} ){const runtime=join(app.isPackaged?process.resourcesPath:dirname,'local-llm',process.platform==='win32'?'llama-server.exe':'llama-server');this.service=new CharacterChatService(join(app.getPath('userData'),'character-chat'),runtime,registry,hooks.select);ipcMain.handle(LOCAL_CHAT_IPC.gesture,(event,kind,request)=>{if(!isTrustedSender(event,this.window,'character-chat',this.devServerUrl)||!['move','resize'].includes(kind)||!validWindowDragRequest(request))throw Error('UNTRUSTED_GESTURE');return (kind==='move'?this.moveGesture:this.resizeGesture).request(request,this.gestureReleased)});this.service.subscribe(()=>{this.window?.webContents.send(LOCAL_CHAT_IPC.changed,this.service.snapshot());this.publish()});ipcMain.handle(LOCAL_CHAT_IPC.getPresentation,event=>{if(!isTrustedSender(event,this.hooks.pet(),'pet',this.devServerUrl))throw Error('UNTRUSTED_SENDER');return this.presentation()});ipcMain.handle(LOCAL_CHAT_IPC.action,async(event,value:LocalChatAction)=>{if(!isTrustedSender(event,this.window,'character-chat',this.devServerUrl))throw Error('UNTRUSTED_SENDER');await this.initialize();try{await this.action(value)}catch(e){this.service.setError(e)}return this.service.snapshot()})}
 private layout = new ChatWindowLayout(join(app.getPath('userData'),'character-chat','window-layout.json'))
 private gestureReleased=true
 private gesturePoint:{x:number;y:number;at:number}|null=null
 private pointerPosition(){const p=this.gesturePoint;return p&&Date.now()-p.at<=1000?{x:p.x,y:p.y}:screen.getCursorScreenPoint()}
 private readonly gestureStart=new NativeDragStart()
 private readonly moveGesture:WindowDragController=new WindowDragController({window:()=>this.window,cursor:()=>this.pointerPosition(),startCursor:()=>this.gestureStart.take(),workArea:p=>screen.getDisplayNearestPoint(p).workArea,allowed:()=>!this.resizeGesture.active,lock:()=>{},finish:(box,committed)=>this.commitLayout(box,committed)})
 private readonly resizeGesture:WindowDragController=new WindowDragController({window:()=>this.window,cursor:()=>this.pointerPosition(),startCursor:()=>this.gestureStart.take(),workArea:p=>screen.getDisplayNearestPoint(p).workArea,allowed:()=>!this.moveGesture.active,lock:()=>{},finish:(box,committed)=>this.commitLayout(box,committed),transform:resizeChatBounds})
 private commitLayout(box:Electron.Rectangle,committed:boolean){const pet=this.hooks.pet();if(!committed||!pet||pet.isDestroyed())return;this.layout.remember(pet.getBounds(),box);void this.saveLayout()}
 private positionWindow:(()=>void)|null=null
 private layoutSaveTimer:ReturnType<typeof setTimeout>|null=null
 private async saveLayout(){if(this.layoutSaveTimer)clearTimeout(this.layoutSaveTimer);this.layoutSaveTimer=null;try{await this.layout.save()}catch{this.service.setError(Error('말풍선 위치를 저장하지 못했습니다.'))}}
 private initialize(){return this.initialized??=Promise.all([this.service.initialize(this.hooks.selected()),this.layout.load()]).then(()=>{})}
 private presentation():LocalChatPresentation{const s=this.service.snapshot();return {active:!!this.window,epoch:s.epoch,characterId:s.character?.id??null,revision:s.character?.revision??null,phase:s.phase==='loading'?'generating':s.phase,definition:this.service.definition,meaning:s.meaning??null}}
 private publish(){const pet=this.hooks.pet();if(pet&&!pet.isDestroyed())pet.webContents.send(LOCAL_CHAT_IPC.presentation,this.presentation())}
 async open(){if(this.disposed)return;this.hooks.reveal();if(this.window){this.window.show();this.window.focus();return}await this.initialize();if(this.disposed)return;const selected=this.registry.get(this.hooks.selected()),current=this.service.snapshot().character;if(selected&&(current?.id!==selected.id||current.revision!==selected.revision))await this.service.selectCharacter(selected.id);if(this.disposed)return;const reopened=this.window as BrowserWindow|null;if(reopened){reopened.show();reopened.focus();return}const win=this.window=new BrowserWindow({...this.layout.value.size,minWidth:CHAT_WINDOW_MIN.width,minHeight:CHAT_WINDOW_MIN.height,maxWidth:CHAT_WINDOW_MAX.width,maxHeight:CHAT_WINDOW_MAX.height,title:'DAEMONLET 캐릭터챗 말풍선',frame:false,transparent:true,hasShadow:false,resizable:true,movable:true,maximizable:false,fullscreenable:false,skipTaskbar:true,alwaysOnTop:true,backgroundColor:'#00000000',show:false,webPreferences:{preload:join(this.dirname,'character-chat-preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false,webSecurity:true,webviewTag:false}});
 secureWebContents(win.webContents,'character-chat',this.devServerUrl);
 win.webContents.on('before-mouse-event',(_event,input)=>{const box=win.getBounds();if(['mouseDown','mouseMove','mouseUp'].includes(input.type)&&Number.isFinite(input.x)&&Number.isFinite(input.y))this.gesturePoint={x:box.x+input.x,y:box.y+input.y,at:Date.now()};if(input.type==='mouseDown'){this.gestureStart.record(box,input,input.button==='left');if(input.button==='left')this.gestureReleased=false}if(input.type==='mouseUp'&&input.button==='left')this.gestureReleased=true});
 const position=()=>{
  const pet=this.hooks.pet();if(win.isDestroyed())return;if(!pet||pet.isDestroyed()||!pet.isVisible()){win.hide();return}
  if(this.moveGesture.active||this.resizeGesture.active)return;
  const bounds=pet.getBounds(),{placement,size}=this.layout.value;
  const area=screen.getDisplayMatching(bubblePlacementReference(bounds,placement)).workArea;
  const box=placement.mode==='relative'?positionRelativeBubble(bounds,area,size,placement):positionActivityBubble(bounds,area,false,false,size);
  win.setMinimumSize(Math.min(CHAT_WINDOW_MIN.width,area.width),Math.min(CHAT_WINDOW_MIN.height,area.height));
  const current=win.getBounds();if(['x','y','width','height'].some(k=>current[k as keyof typeof current]!==box[k as keyof typeof box]))win.setBounds(box);
  win.setAlwaysOnTop(true,'floating');if(!win.isVisible())win.showInactive()
 };
 this.positionWindow=position;
 const remember=(_event:Electron.Event,box:Electron.Rectangle)=>{const pet=this.hooks.pet();if(!pet||pet.isDestroyed())return;this.layout.remember(pet.getBounds(),box);if(this.layoutSaveTimer)clearTimeout(this.layoutSaveTimer);this.layoutSaveTimer=setTimeout(()=>void this.saveLayout(),200)};
 // These native events are not emitted by our automatic setBounds calls.
 win.on('will-move',remember);win.on('will-resize',remember);
 const pet=this.hooks.pet();const events=['move','resize','show','hide','minimize','restore'] as const;
 for(const e of events)(pet as EventEmitter|null)?.on(e,position);
 const displays=['display-added','display-removed','display-metrics-changed'] as const;
 for(const e of displays)(screen as unknown as EventEmitter).on(e,position);
 this.detach=()=>{for(const e of events)(pet as EventEmitter|null)?.removeListener(e,position);for(const e of displays)(screen as unknown as EventEmitter).removeListener(e,position);this.positionWindow=null};
 this.hooks.active(true);this.publish();win.once('ready-to-show',()=>{position();win.show();win.focus()});win.once('closed',()=>{if(this.layoutSaveTimer)void this.saveLayout();this.window=null;this.detach?.();this.detach=null;if(!this.disposed)void this.service.stop().catch(e=>this.service.setError(e));this.hooks.active(false);this.publish()});void win.loadURL(expectedRendererUrl('character-chat',this.devServerUrl))}
 async selectedCharacterChanged(id:string){if(this.disposed||this.service.applyingCharacterId===id)return;const current=this.service.snapshot().character,entry=this.registry.get(id);if(this.window&&entry&&(current?.id!==id||current.revision!==entry.revision))await this.service.selectCharacter(id)}
 private async action(value:LocalChatAction){if(!value||typeof value!=='object'||typeof value.type!=='string')throw Error('잘못된 요청');if('id' in value&&value.id!==undefined&&(!['model','download','remove-model','import-model'].includes(value.type)?typeof value.id!=='string'||value.id.length>80:!['E4B','12B'].includes(value.id)))throw Error('잘못된 선택');switch(value.type){
 case 'layout-reset':this.moveGesture.cancel();this.resizeGesture.cancel();this.layout.reset();this.positionWindow?.();await this.saveLayout();break;case 'attention':if(typeof value.active!=='boolean')throw Error('잘못된 요청');this.service.attention(value.active);break;case 'memory-save':await this.service.saveMemory(value.text,value.id);break;case 'memory-delete':await this.service.deleteMemory(value.id);break;case 'snapshot':break;case 'send':await this.service.send(value.text);break;case 'stop':await this.service.stop();break;case 'retry':await this.service.retry();break;case 'new':await this.service.newChat();break;case 'conversation':await this.service.selectConversation(value.id);break;case 'delete':await this.service.deleteConversation(value.id);break;case 'character':await this.service.selectCharacter(value.id);break;case 'model':await this.service.selectModel(value.id);break;
 case 'download':void this.service.models.download(value.id).then(()=>this.service.refreshModels()).catch(e=>this.service.setError(e));break;case 'cancel-download':await this.service.models.cancel();break;
 case 'import-model':{const win=this.window;if(!win||win.isDestroyed())break;const result=await dialog.showOpenDialog(win,{title:'공식 GGUF 파일 가져오기',filters:[{name:'GGUF',extensions:['gguf']}],properties:['openFile']});if(this.window===win&&!win.isDestroyed()&&!result.canceled&&result.filePaths[0]){await this.service.models.importFile(value.id,result.filePaths[0]);await this.service.refreshModels()}break}
 case 'remove-model':await this.service.stop();await this.service.models.remove(value.id);await this.service.refreshModels();break;
 case 'import-pack':{if(this.importing)throw Error('캐릭터를 가져오는 중입니다.');const win=this.window;if(!win||win.isDestroyed())break;this.importing=true;const owner='character-chat-'+win.webContents.id;const current=()=>this.window===win&&!win.isDestroyed();try{const picked=await dialog.showOpenDialog(win,{title:'캐릭터팩 설치',filters:[{name:'Character pack',extensions:['petchar']}],properties:['openFile']});if(!current()||picked.canceled||!picked.filePaths[0])break;const preview=await this.registry.prepareImport(picked.filePaths[0],owner);if(!current())break;const answer=await dialog.showMessageBox(win,{type:'question',message:preview.entry.name,detail:preview.entry.version+' 캐릭터팩을 설치합니다.',buttons:['취소','설치'],defaultId:1,cancelId:0});if(current()&&answer.response===1){const entry=await this.registry.commitImport(preview.token,owner);if(current())await this.service.selectCharacter(entry.id)}}finally{await this.registry.cancelImport(owner);this.importing=false}break}
 case 'codex-mode':this.window?.close();break;default:throw Error('지원하지 않는 요청')
 }}
 dispose():Promise<void>{if(this.disposing)return this.disposing;this.disposed=true;this.disposing=this.finishDispose();return this.disposing}
 private async finishDispose(){this.moveGesture.cancel();this.resizeGesture.cancel();ipcMain.removeHandler(LOCAL_CHAT_IPC.gesture);ipcMain.removeHandler(LOCAL_CHAT_IPC.action);ipcMain.removeHandler(LOCAL_CHAT_IPC.getPresentation);this.detach?.();const closing=this.service.close();await this.initialized?.catch(()=>{});try{await this.saveLayout();await closing}finally{this.window?.destroy();this.window=null}}
}
