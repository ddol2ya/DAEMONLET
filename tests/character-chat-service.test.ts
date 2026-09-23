import {afterEach, expect, it, vi} from 'vitest'
import {mkdtemp, rm, readFile, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {CharacterChatService} from '../electron/main/character-chat/CharacterChatService'
import {ConversationStore} from '../electron/main/character-chat/ConversationStore'
import {randomUUID} from 'node:crypto'
import {CHAT_STORAGE_LIMITS,encodeStoredChats,type StoredChats} from '../electron/main/character-chat/ConversationStore'
import {neutralMeaning,parseChatReply} from '../electron/shared/character-chat-semantics'
import type {CharacterRegistry} from '../electron/main/CharacterRegistry'

const roots: string[] = []
const services: CharacterChatService[] = []
afterEach(async () => {
  for (const service of services.splice(0)) await service.close()
  for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true})
  vi.restoreAllMocks()
})
async function fixture(displayName?:string, options:{root?:string;initialize?:boolean;apply?:(entry:any)=>Promise<void>}={}) {
  const root = options.root || await mkdtemp(join(tmpdir(), 'chat-service-'))
  roots.push(root)
  const entries = ['gpichan', 'synthetic-b'].map(id => ({id, name: id, revision: 'revision-' + id, status: 'ready'}))
  const registry = {
    snapshot: () => ({entries}), get: (id: string) => entries.find(e => e.id === id),
    ensureReady: async (entry: unknown) => entry,
    readPersonaAsset: async (entry: {id: string}, path:string) => Buffer.from(JSON.stringify(path==='chat.json'?{schemaVersion:1,profile:{displayName},presentation:{rules:[]}}:{
      schemaVersion: 1, id: entry.id, label: entry.id, ...(displayName?{chat:'chat.json'}:{}),
      base: {source: 'source.png', psd: 'model.psd'}, poses: [],
    })),
  } as unknown as CharacterRegistry
  const service = new CharacterChatService(root, '/unused-test-runtime', registry,options.apply)
  services.push(service)
  vi.spyOn(service.runtime, 'available').mockResolvedValue(true)
  vi.spyOn(service.runtime, 'start').mockResolvedValue()
  vi.spyOn(service.runtime, 'stop').mockResolvedValue()
  vi.spyOn(service.runtime, 'count').mockResolvedValue(1000)
  vi.spyOn(service.models, 'installed').mockResolvedValue(['E4B', '12B'])
  vi.spyOn(service.models, 'verify').mockResolvedValue('/unused-test-model')
  if(options.initialize!==false){
    if(!options.root){const seed=chats(1);seed.memories={};await (service as any).store.save(seed)}
    await service.initialize()
  }
  return {service, root, registry, store:(service as any).store as ConversationStore}
}
it('legacy packs without persona keep memories separate; deletion persists without deleting other characters', async () => {
  const {service, root} = await fixture()
  await service.saveMemory('explicit preference')
  const memoryId = service.snapshot().memories![0].id
  await service.saveMemory('corrected preference', memoryId)
  const conversationId = service.snapshot().conversation!.id
  await service.selectCharacter('synthetic-b')
  expect(service.snapshot().memories).toEqual([])
  await expect(service.selectConversation(conversationId)).rejects.toThrow('다릅니다')
  await service.saveMemory('other character only')
  await service.selectCharacter('gpichan')
  expect(service.snapshot().memories!.map(m => m.text)).toEqual(['corrected preference'])
  await service.deleteConversation(conversationId)
  expect(service.snapshot().memories).toHaveLength(1)
  await service.deleteMemory(memoryId)
  const saved = (await new ConversationStore(root).load()).value!
  expect(saved.conversations.some(c => c.id === conversationId)).toBe(false)
  expect(saved.memories.gpichan).toEqual([])
  expect(saved.memories['synthetic-b'][0].text).toBe('other character only')
})
it('character switching discards late chunks and metadata, then retry replaces the completed pair', async () => {
  const {service} = await fixture()
  let finish: (() => void) | undefined
  const generate = vi.spyOn(service.runtime, 'generate').mockImplementationOnce(async (_messages, onText) => {
    onText('partial')
    await new Promise<void>(resolve => { finish = resolve })
    onText('stale text must not cross characters')
    return {text: 'stale', meaning: {...neutralMeaning(), emotion: 'happy'}}
  })
  vi.mocked(service.runtime.stop).mockImplementation(async () => { finish?.() })
  await service.send('first')
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  await service.selectCharacter('synthetic-b')
  expect(service.snapshot().conversation).toBeNull()
  expect(service.snapshot().meaning).toBeNull()
  generate.mockImplementation(async (_messages, onText) => {
    onText('new reply')
    return {text: 'new reply', meaning: neutralMeaning()}
  })
  await service.send('new message')
  await vi.waitFor(() => expect(service.snapshot().conversation!.messages.at(-1)?.status).toBe('complete'))
  await service.retry()
  await vi.waitFor(() => expect(service.snapshot().conversation!.messages.at(-1)?.status).toBe('complete'))
  const messages = service.snapshot().conversation!.messages
  expect(messages.map(m => m.text)).toEqual(['new message', 'new reply'])
  expect(messages[1].binding?.characterId).toBe('synthetic-b')
})

it('long history keeps complete pairs and reserves output before submitting generation', async () => {
  const {service} = await fixture()
  const estimate = (messages: Array<{content: string}>) => Math.ceil(messages.map(m => m.content).join('').length / 3)
  vi.mocked(service.runtime.count).mockImplementation(async messages => estimate(messages))
  const requests: Array<Array<{role: string; content: string}>> = []
  vi.spyOn(service.runtime, 'generate').mockImplementation(async (messages, onText) => {
    expect(estimate(messages) + 512 + 256).toBeLessThanOrEqual(8192)
    requests.push(messages)
    onText('complete answer')
    return {text: 'complete answer', meaning: neutralMeaning()}
  })
  for (let turn = 0; turn < 8; turn++) {
    await service.send(String(turn) + ' synthetic history '.repeat(270))
    await vi.waitFor(() => expect(service.snapshot().conversation!.messages.at(-1)?.status).toBe('complete'), {interval: 1})
    await service.stop()
  }
  const last = requests.at(-1)!
  expect(last.length).toBeLessThan(17)
  expect(last[0].role).toBe('system')
  for (let i = 1; i < last.length; i++) expect(last[i].role).toBe(i % 2 ? 'user' : 'assistant')
  expect(service.snapshot().conversation!.summary?.text.length).toBeLessThanOrEqual(1200)
  expect(service.snapshot().contextNotice).toBeTruthy()
})

it('retains the last reply emotion over time and input focus until the next request or explicit reset', async () => {
  const {service} = await fixture()
  const meaning = {...neutralMeaning(), emotion: 'concerned' as const}
  vi.spyOn(service.runtime, 'generate').mockImplementation(async (_messages, onText) => {
    onText('I am concerned.')
    return {text: 'I am concerned.', meaning}
  })
  await service.send('hello')
  await vi.waitFor(() => expect(service.snapshot().conversation!.messages.at(-1)?.status).toBe('complete'))
  vi.useFakeTimers()
  try {
    await vi.advanceTimersByTimeAsync(60000)
    service.attention(true)
    expect(service.snapshot().meaning).toEqual(meaning)
    service.attention(false)
    expect(service.snapshot().meaning).toEqual(meaning)
  } finally { vi.useRealTimers() }
  // Wait for the final disk save, independently of the visible completion event.
  await vi.waitFor(() => expect((service as any).job).toBeNull())
  const observed: Array<ReturnType<typeof service.snapshot>> = []
  const off = service.subscribe(() => observed.push(service.snapshot()))
  await service.send('next')
  expect(observed.find(s => s.phase === 'loading')?.meaning).toBeNull()
  await vi.waitFor(() => expect(service.snapshot().conversation!.messages.at(-1)?.status).toBe('complete'))
  off()
  await service.newChat()
  expect(service.snapshot().meaning).toBeNull()
})

it('uses the declared conversation name while preserving pack names and legacy fallback', async () => {
 const {service}=await fixture('별이');
 expect(service.snapshot().displayName).toBe('별이');
 expect(service.snapshot().character?.name).toBe('gpichan');
 const legacy=await fixture();
 expect(legacy.service.snapshot().displayName).toBe('gpichan');
})

function deferred<T=void>() {let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r});return {promise,resolve}}
async function complete(service:CharacterChatService) {await vi.waitFor(()=>expect((service as any).job).toBeNull())}
function chats(count:number,messages=0):StoredChats {
 const conversations=Array.from({length:count},()=>({id:randomUUID(),characterId:'gpichan',title:'fixture',updatedAt:new Date().toISOString(),messages:Array.from({length:messages},(_,i)=>({id:randomUUID(),role:i%2?'assistant' as const:'user' as const,text:'synthetic',status:'complete' as const,createdAt:new Date().toISOString()}))}))
 return {version:2,model:'E4B',characterId:'gpichan',current:conversations[0]?.id,conversations,memories:{gpichan:[{id:randomUUID(),text:'keep memory'}]}}
}
it('F1: reopening without initializing and repeated close preserve conversation and memory bytes',async()=>{
 const first=await fixture();await first.service.saveMemory('keep this');await first.service.close()
 const before=await readFile(first.store.file)
 const unused=await fixture(undefined,{root:first.root,initialize:false})
 const a=unused.service.close(),b=unused.service.close();expect(a).toBe(b);await a
 expect((await readFile(first.store.file)).equals(before)).toBe(true)
 const reopened=await fixture(undefined,{root:first.root});expect(reopened.service.snapshot().memories?.[0].text).toBe('keep this')
 expect(reopened.service.snapshot().conversations).toHaveLength(1)
})
it('F1: close during initialization waits without writing a partially loaded store',async()=>{
 const {service,store}=await fixture(undefined,{initialize:false});await store.save(chats(1));const before=await readFile(store.file)
 const gate=deferred();const load=store.load.bind(store);vi.spyOn(store,'load').mockImplementation(async()=>{await gate.promise;return load()})
 const init=service.initialize(),closing=service.close();gate.resolve();await Promise.all([init,closing]);expect((await readFile(store.file)).equals(before)).toBe(true)
})
it('F1: failed initialization never writes defaults on close',async()=>{
 const {service,store,registry}=await fixture(undefined,{initialize:false});await store.save(chats(1));const before=await readFile(store.file)
 vi.spyOn(registry,'readPersonaAsset').mockRejectedValue(Error('read denied'))
 await expect(service.initialize()).rejects.toThrow();await service.close();expect((await readFile(store.file)).equals(before)).toBe(true)
})
it('initialization prefers the currently displayed character without changing the desktop',async()=>{
 const apply=vi.fn();const {service}=await fixture(undefined,{initialize:false,apply})
 await service.initialize('synthetic-b');expect(service.snapshot().character?.id).toBe('synthetic-b');expect(apply).not.toHaveBeenCalled()
})
it.each(['apply','persona','persona-parse','removed','revision'])('F2: %s failure retains coherent ownership and never submits another character history',async fault=>{
 const apply=vi.fn(async()=>{});const {service,registry}=await fixture('Name',{apply})
 const requests:any[]=[];vi.spyOn(service.runtime,'generate').mockImplementation(async(messages,onText)=>{requests.push(messages);onText('answer');return {text:'answer',meaning:neutralMeaning()}})
 await service.send('A-private-marker');await complete(service)
 const before=service.snapshot()
 if(fault==='apply')apply.mockRejectedValueOnce(Error('apply failed'))
 if(fault==='persona'){const read=registry.readPersonaAsset.bind(registry);vi.spyOn(registry,'readPersonaAsset').mockImplementation(async(e,p)=>{if(e.id==='synthetic-b')throw Error('persona failed');return read(e,p)})}
 if(fault==='persona-parse'){const read=registry.readPersonaAsset.bind(registry);vi.spyOn(registry,'readPersonaAsset').mockImplementation(async(e,p)=>{if(e.id==='synthetic-b'){if(p==='persona.json')return Buffer.from('{}');const c=JSON.parse(new TextDecoder().decode(await read(e,p)));c.persona='persona.json';return Buffer.from(JSON.stringify(c))}return read(e,p)})}
 if(fault==='removed')vi.spyOn(registry,'ensureReady').mockImplementation(async e=>{(registry.snapshot().entries as any[]).splice(1,1);return e as any})
 if(fault==='revision')apply.mockImplementationOnce(async()=>{(registry.snapshot().entries[1] as any).revision='new revision'})
 const states:any[]=[];const off=service.subscribe(()=>states.push(service.snapshot()))
 await expect(service.selectCharacter('synthetic-b')).rejects.toThrow();off()
 expect(service.snapshot().character).toEqual(before.character);expect(service.snapshot().conversation?.id).toBe(before.conversation?.id)
 expect(states.every(s=>!s.conversation||s.conversation.characterId===s.character?.id)).toBe(true)
 await service.send('still A');await complete(service)
 expect(requests.at(-1)[0].content).not.toContain('synthetic-b')
 expect(service.snapshot().conversation?.messages.at(-1)?.binding?.characterId).toBe('gpichan')
})
it('F2: transitions serialize A→B→A, block send/retry in flight, and preserve same-ID update history',async()=>{
 const gate=deferred(),entered=deferred();const apply=vi.fn(async(e:any)=>{if(e.id==='synthetic-b'){entered.resolve();await gate.promise}})
 const {service,registry}=await fixture(undefined,{apply});const id=service.snapshot().conversation!.id
 const b=service.selectCharacter('synthetic-b');await entered.promise
 await expect(service.send('blocked')).rejects.toThrow('변경');await expect(service.retry()).rejects.toThrow('변경')
 const a=service.selectCharacter('gpichan');gate.resolve();await Promise.all([b,a]);expect(service.snapshot().conversation!.id).toBe(id)
 ;(registry.snapshot().entries[0] as any).revision='updated';await service.selectCharacter('gpichan')
 expect(service.snapshot().character?.revision).toBe('updated');expect(service.snapshot().conversation!.id).toBe(id)
})
it('F2: failed visual rollback blocks generation until a successful re-selection',async()=>{
 const apply=vi.fn(async()=>{});const {service}=await fixture(undefined,{apply});apply.mockRejectedValue(Error('unavailable'))
 await expect(service.selectCharacter('synthetic-b')).rejects.toThrow();await expect(service.send('blocked')).rejects.toThrow('복원')
 apply.mockResolvedValue();await service.selectCharacter('gpichan')
 vi.spyOn(service.runtime,'generate').mockResolvedValue({text:'ok',meaning:neutralMeaning()});await service.send('works');await complete(service)
})
it('F2: ownership mismatches and unannounced revision changes cannot reach retry or generation',async()=>{
 const {service,registry}=await fixture();const generate=vi.spyOn(service.runtime,'generate')
 ;(service as any).data.conversations[0].characterId='synthetic-b'
 await expect(service.send('bad')).rejects.toThrow('다릅니다');await expect(service.retry()).rejects.toThrow('다릅니다')
 ;(service as any).data.conversations[0].characterId='gpichan'
 ;(registry.snapshot().entries[0] as any).revision='new'
 // Registry entries are references, so use a replaced entry rather than mutate the selected object.
 ;(service as any).state.character={...(service as any).state.character,revision:'old'}
 await expect(service.send('bad')).rejects.toThrow('변경');expect(generate).not.toHaveBeenCalled()
})
it('F3: 499→500 succeeds, 501 is rejected without mutation, and deletion still works',async()=>{
 const {service,store}=await fixture(undefined,{initialize:false});await store.save(chats(499));await service.initialize()
 await service.newChat();vi.spyOn(service.runtime,'generate').mockResolvedValue({text:'ok',meaning:neutralMeaning()});await service.send('conversation 500');await complete(service);const last=service.snapshot().conversation!.id
 await service.newChat();const before=await readFile(store.file);await expect(service.send('conversation 501')).rejects.toThrow('500');expect(service.snapshot().conversations).toHaveLength(500);expect((await readFile(store.file)).equals(before)).toBe(true)
 await service.deleteConversation(last);expect(service.snapshot().conversations).toHaveLength(499)
})
it('F3: message limit rejects the extra pair without changing memory or disk and still allows deleting',async()=>{
 const {service,store}=await fixture(undefined,{initialize:false});await store.save(chats(1,3998));await service.initialize()
 vi.spyOn(service.runtime,'generate').mockResolvedValue({text:'last',meaning:neutralMeaning()});await service.send('last user');await complete(service)
 expect(service.snapshot().conversation?.messages).toHaveLength(4000);const before=await readFile(store.file)
 await expect(service.send('too many')).rejects.toThrow('메시지 한도');expect((await readFile(store.file)).equals(before)).toBe(true)
 await service.deleteConversation(service.snapshot().conversation!.id);expect(service.snapshot().conversation).toBeNull()
})
it.each(['ENOSPC','EACCES'])('F3: %s write failure rolls back new conversation and permits subsequent deletion',async code=>{
 const {service,store}=await fixture();await service.saveMemory('durable');const before=await readFile(store.file),snapshot=service.snapshot()
 vi.spyOn(store,'save').mockRejectedValueOnce(Object.assign(Error(code),{code}))
 await expect(service.newChat()).rejects.toThrow('저장하지');expect(service.snapshot().conversations).toEqual(snapshot.conversations);expect((await readFile(store.file)).equals(before)).toBe(true)
 await service.deleteConversation(snapshot.conversation!.id);expect(service.snapshot().conversations).toHaveLength(0)
})
it('F3: failed send and failed final response saves preserve a valid prior state, then deletion works',async()=>{
 const {service,store}=await fixture();await service.saveMemory('keep');const before=await readFile(store.file)
 const save=vi.spyOn(store,'save').mockRejectedValueOnce(Error('ENOSPC'))
 await expect(service.send('unsaved')).rejects.toThrow('저장하지');expect(service.snapshot().conversation?.messages).toHaveLength(0);expect((await readFile(store.file)).equals(before)).toBe(true)
 vi.spyOn(service.runtime,'generate').mockImplementation(async()=>{save.mockRejectedValueOnce(Error('ENOSPC'));return {text:'unsaved reply',meaning:neutralMeaning()}})
 await service.send('accepted');await complete(service);expect(service.snapshot().error).toContain('저장하지');expect(service.snapshot().conversation?.messages.at(-1)?.status).toBe('stopped')
 await service.deleteConversation(service.snapshot().conversation!.id);expect(service.snapshot().conversation).toBeNull()
})
it.each([{intensity:2},{emotion:'unknown'},{intent:'unknown'},{gesture:'unknown'},{}])('F4: invalid/missing meaning %j preserves complete dialogue and next-turn context',async patch=>{
 const {service,store}=await fixture();const requests:any[]=[]
 vi.spyOn(service.runtime,'generate').mockImplementation(async(messages,onText)=>{requests.push(messages);onText('valid dialogue');return parseChatReply(JSON.stringify({text:'valid dialogue',...(Object.keys(patch).length?{...neutralMeaning(),...patch}:patch)}))})
 await service.send('first');await complete(service)
 expect(service.snapshot().conversation?.messages.at(-1)?.status).toBe('complete');expect(service.snapshot().meaning).toEqual(neutralMeaning());expect(service.snapshot().semanticWarning).toContain('기본 표정')
 expect((await store.load()).value?.conversations[0].messages.at(-1)?.semanticDiagnostics?.length).toBe(1)
 await service.send('second');await complete(service)
 expect(requests[1].slice(1)).toContainEqual({role:'user',content:'first'});expect(requests[1]).toContainEqual({role:'assistant',content:'valid dialogue'})
})
it.each(['{"text":"cut','{"text":"<think>private</think>"}','{"text":"ok","command":"execute"}','{"text":""}'])('F4: unsafe/incomplete output remains an error: %s',async raw=>{
 const {service}=await fixture();vi.spyOn(service.runtime,'generate').mockImplementation(async()=>parseChatReply(raw))
 await service.send('hello');await complete(service);expect(service.snapshot().conversation?.messages.at(-1)?.status).toBe('error');expect(service.snapshot().error).not.toContain('CHAT_')
})

it('F3: a near-32MiB store rejects generation before mutation and deletion recovers space',async()=>{
 const {service,store}=await fixture(undefined,{initialize:false});const data=chats(1,1050)
 for(const m of data.conversations[0].messages)m.text='x'.repeat(32000)
 while(Buffer.byteLength(JSON.stringify(data))>CHAT_STORAGE_LIMITS.bytes-2000)data.conversations[0].messages.pop()
 // Fill to within 2 KiB of the file boundary, below the response reservation.
 const size=Buffer.byteLength(JSON.stringify(data)),last={...data.conversations[0].messages[0],id:randomUUID(),text:''}
 data.conversations[0].messages.push(last)
 last.text='x'.repeat(Math.max(0,CHAT_STORAGE_LIMITS.bytes-2000-size-(Buffer.byteLength(JSON.stringify(last))+1)))
 await store.save(data);await service.initialize();const before=await readFile(store.file)
 const generate=vi.spyOn(service.runtime,'generate');await expect(service.send('no room')).rejects.toThrow('용량 한도');expect(generate).not.toHaveBeenCalled();expect((await readFile(store.file)).equals(before)).toBe(true)
 await service.deleteConversation(service.snapshot().conversation!.id);expect((await readFile(store.file)).length).toBeLessThan(2000)
})
it('F3: storage rejects over-32MiB candidates while leaving the original file intact',async()=>{
 const {store}=await fixture(undefined,{initialize:false});await store.save(chats(1));const before=await readFile(store.file)
 const overflow=chats(1,1100);for(const m of overflow.conversations[0].messages)m.text='x'.repeat(32000)
 await expect(store.save(overflow)).rejects.toThrow('용량 한도');expect((await readFile(store.file)).equals(before)).toBe(true)
})

it('F2: a revision replaced during generation discards subsequent chunks and completion',async()=>{
 const {service,registry}=await fixture();const gate=deferred(),entered=deferred()
 vi.spyOn(service.runtime,'generate').mockImplementation(async(_messages,onText)=>{onText('partial');entered.resolve();await gate.promise;onText('late');return {text:'late',meaning:neutralMeaning()}})
 await service.send('hello');await entered.promise
 ;(registry.snapshot().entries[0] as any).revision='new';gate.resolve();await complete(service)
 expect(service.snapshot().conversation?.messages.at(-1)?.text).toBe('partial');expect(service.snapshot().conversation?.messages.at(-1)?.status).toBe('stopped')
})

it('empty drafts are not saved and repeated new-chat clicks never create rows',async()=>{
 const {service,store}=await fixture(undefined,{initialize:false});await service.initialize()
 expect(service.snapshot().conversation).toBeNull();expect(service.snapshot().conversations).toHaveLength(0)
 for(let i=0;i<4;i++)await service.newChat()
 expect((await store.load()).value?.conversations).toHaveLength(0)
 vi.spyOn(service.runtime,'generate').mockResolvedValue({text:'reply',meaning:neutralMeaning()})
 await service.send('first message');await complete(service);expect(service.snapshot().conversations).toHaveLength(1)
 await service.newChat();await service.newChat();expect(service.snapshot().conversations).toHaveLength(1);expect(service.snapshot().conversation).toBeNull()
})
it('legacy empty conversations actually decrease on deletion, including the last one and after restart',async()=>{
 const {service,store,root}=await fixture(undefined,{initialize:false});const data=chats(3);await store.save(data);await service.initialize()
 for(const row of data.conversations)await service.deleteConversation(row.id)
 expect(service.snapshot().conversation).toBeNull();expect(service.snapshot().conversations).toHaveLength(0)
 expect((await store.load()).value?.memories).toEqual(data.memories)
 await service.close();const reopened=await fixture(undefined,{root});expect(reopened.service.snapshot().conversations).toHaveLength(0);expect(reopened.service.snapshot().conversation).toBeNull()
 vi.spyOn(reopened.service.runtime,'generate').mockResolvedValue({text:'after deletion',meaning:neutralMeaning()});await reopened.service.send('still works');await complete(reopened.service)
 expect(reopened.service.snapshot().conversations).toHaveLength(1)
})

it.each(['load','persona'])('R1: retries a transient %s initialization failure without changing saved bytes',async fault=>{
 const {service,store,registry}=await fixture(undefined,{initialize:false});await store.save(chats(1));const before=await readFile(store.file)
 if(fault==='load')vi.spyOn(store,'load').mockRejectedValueOnce(Error('temporary read failure'))
 else vi.spyOn(registry,'readPersonaAsset').mockRejectedValueOnce(Error('temporary persona failure'))
 const first=service.initialize();await expect(first).rejects.toThrow('temporary')
 const retry=service.initialize();expect(retry).not.toBe(first);await retry
 expect(service.snapshot().conversations).toHaveLength(1);expect((await readFile(store.file)).equals(before)).toBe(true)
})
it('R2: same-tick stop cancels an accepted but not yet executed send',async()=>{
 const {service}=await fixture();const generate=vi.spyOn(service.runtime,'generate').mockResolvedValue({text:'must not run',meaning:neutralMeaning()})
 const sending=service.send('queued'),stopping=service.stop();await Promise.all([sending,stopping])
 expect(service.runtime.start).not.toHaveBeenCalled();expect(generate).not.toHaveBeenCalled();expect((service as any).job).toBeNull();expect(service.snapshot().phase).toBe('idle');expect(service.snapshot().conversation?.messages).toHaveLength(0)
})
it('R1: concurrent initialization shares one read, then retry uses the latest selection/revision',async()=>{
 const {service,store,registry}=await fixture(undefined,{initialize:false});await store.save(chats(1));const before=await readFile(store.file)
 const gate=deferred();const load=vi.spyOn(store,'load').mockImplementationOnce(async()=>{await gate.promise;throw Error('temporary')})
 const first=service.initialize(),same=service.initialize();expect(same).toBe(first)
 const failed=expect(first).rejects.toThrow('temporary');gate.resolve();await failed
 ;(registry.snapshot().entries[1] as any).revision='latest'
 await service.initialize('synthetic-b');expect(load).toHaveBeenCalledTimes(2);expect(service.snapshot().character?.id).toBe('synthetic-b');expect(service.snapshot().character?.revision).toBe('latest');expect((await readFile(store.file)).equals(before)).toBe(true)
})
it('R1: close overlapping a failed attempt forbids retries and preserves original data',async()=>{
 const {service,store}=await fixture(undefined,{initialize:false});await store.save(chats(1));const before=await readFile(store.file)
 const gate=deferred();vi.spyOn(store,'load').mockImplementationOnce(async()=>{await gate.promise;throw Error('temporary')})
 const first=service.initialize(),failed=expect(first).rejects.toThrow('temporary'),closed=service.close();gate.resolve();await Promise.all([failed,closed])
 await expect(service.initialize()).rejects.toThrow('종료');expect((await readFile(store.file)).equals(before)).toBe(true)
})
it('R2: queued retry then stop preserves the completed pair and starts nothing',async()=>{
 const {service}=await fixture();const generate=vi.spyOn(service.runtime,'generate').mockResolvedValue({text:'kept',meaning:neutralMeaning()})
 await service.send('original');await complete(service);const before=service.snapshot().conversation!.messages
 generate.mockClear();vi.mocked(service.runtime.start).mockClear()
 await Promise.all([service.retry(),service.stop()]);expect(generate).not.toHaveBeenCalled();expect(service.runtime.start).not.toHaveBeenCalled();expect(service.snapshot().conversation!.messages).toEqual(before)
})
it('R2: a send accepted after stop waits for cleanup and remains valid',async()=>{
 const {service}=await fixture();const cleanup=deferred()
 vi.mocked(service.runtime.stop).mockImplementationOnce(()=>cleanup.promise)
 const generate=vi.spyOn(service.runtime,'generate').mockResolvedValue({text:'fresh answer',meaning:neutralMeaning()})
 const old=service.send('cancel me'),stopped=service.stop(),fresh=service.send('keep me')
 await old;expect(service.runtime.start).not.toHaveBeenCalled();cleanup.resolve();await Promise.all([stopped,fresh]);await complete(service)
 expect(generate).toHaveBeenCalledTimes(1);expect(service.snapshot().conversation!.messages.map(m=>m.text)).toEqual(['keep me','fresh answer'])
})
it.each(['stop','close'] as const)('R2: %s during an initial save still prevents model startup',async action=>{
 const {service,store}=await fixture();const entered=deferred(),finish=deferred(),save=store.save.bind(store)
 vi.spyOn(store,'save').mockImplementationOnce(async data=>{entered.resolve();await finish.promise;return save(data)})
 const generate=vi.spyOn(service.runtime,'generate');const send=service.send('saving');await entered.promise;const stopped=service[action]();finish.resolve();await Promise.all([send,stopped])
 expect(service.runtime.start).not.toHaveBeenCalled();expect(generate).not.toHaveBeenCalled();expect((await store.load()).value?.conversations[0].messages.at(-1)?.status).toBe('stopped')
})
it.each(['verify','start'] as const)('R2: stop while awaiting runtime %s drops later generation',async stage=>{
 const {service}=await fixture();const entered=deferred(),finish=deferred()
 if(stage==='verify')vi.mocked(service.models.verify).mockImplementationOnce(async()=>{entered.resolve();await finish.promise;return '/unused'})
 else vi.mocked(service.runtime.start).mockImplementationOnce(async()=>{entered.resolve();await finish.promise})
 const generate=vi.spyOn(service.runtime,'generate');await service.send('cancel pending');await entered.promise;const stopped=service.stop();finish.resolve();await stopped
 expect(generate).not.toHaveBeenCalled();expect((service as any).job).toBeNull();expect(service.snapshot().phase).toBe('idle')
})
it.each(['model','character'] as const)('R2: %s transition invalidates previously queued sends',async target=>{
 const {service}=await fixture();const generate=vi.spyOn(service.runtime,'generate')
 const old=service.send('cancel before transition'),transition=target==='model'?service.selectModel('12B'):service.selectCharacter('synthetic-b')
 await Promise.all([old,transition]);expect(generate).not.toHaveBeenCalled();expect(service.runtime.start).not.toHaveBeenCalled()
})
it('R2: rapid send/stop boundaries only permit the last explicitly accepted request',async()=>{
 const {service}=await fixture();const generate=vi.spyOn(service.runtime,'generate').mockResolvedValue({text:'final',meaning:neutralMeaning()})
 const work:Promise<void>[]=[];for(let i=0;i<3;i++){work.push(service.send('old '+i));work.push(service.stop())}
 work.push(service.send('new'));await Promise.all(work);await complete(service)
 expect(generate).toHaveBeenCalledTimes(1);expect(service.snapshot().conversation!.messages.map(m=>m.text)).toEqual(['new','final'])
})
it('model replacement waits for owned runtime cleanup and blocks new sends until verified installation finishes',async()=>{
 const {service}=await fixture(),cleanup=deferred(),install=deferred()
 vi.mocked(service.runtime.stop).mockImplementationOnce(()=>cleanup.promise)
 const importer=vi.spyOn(service.models,'importFile').mockImplementation(async()=>{await install.promise})
 const task=service.installModel('E4B','/read-only-original.gguf')
 await expect(service.send('during installation')).rejects.toThrow('모델 설치')
 await Promise.resolve();expect(importer).not.toHaveBeenCalled()
 cleanup.resolve();await vi.waitFor(()=>expect(importer).toHaveBeenCalledWith('E4B','/read-only-original.gguf'))
 install.resolve();await task
 expect(service.snapshot().installed).toContain('E4B')
})
it('unsupported runtime rejects download before any model transfer starts',async()=>{
 const {service}=await fixture()
 vi.mocked(service.runtime.available).mockResolvedValue(false);service.runtime.availabilityError='NVIDIA CUDA unavailable'
 const download=vi.spyOn(service.models,'download')
 await expect(service.installModel('E4B')).rejects.toThrow('NVIDIA CUDA unavailable')
 expect(download).not.toHaveBeenCalled();expect(service.snapshot().runtimeAvailable).toBe(false)
})
