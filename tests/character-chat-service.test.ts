import {afterEach, expect, it, vi} from 'vitest'
import {mkdtemp, rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {CharacterChatService} from '../electron/main/character-chat/CharacterChatService'
import {ConversationStore} from '../electron/main/character-chat/ConversationStore'
import {neutralMeaning} from '../electron/shared/character-chat-semantics'
import type {CharacterRegistry} from '../electron/main/CharacterRegistry'

const roots: string[] = []
const services: CharacterChatService[] = []
afterEach(async () => {
  for (const service of services.splice(0)) await service.close()
  for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true})
  vi.restoreAllMocks()
})
async function fixture(displayName?:string) {
  const root = await mkdtemp(join(tmpdir(), 'chat-service-'))
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
  const service = new CharacterChatService(root, '/unused-test-runtime', registry)
  services.push(service)
  vi.spyOn(service.runtime, 'available').mockResolvedValue(true)
  vi.spyOn(service.runtime, 'start').mockResolvedValue()
  vi.spyOn(service.runtime, 'stop').mockResolvedValue()
  vi.spyOn(service.runtime, 'count').mockResolvedValue(1000)
  vi.spyOn(service.models, 'installed').mockResolvedValue(['E4B', '12B'])
  vi.spyOn(service.models, 'verify').mockResolvedValue('/unused-test-model')
  await service.initialize()
  return {service, root}
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
  expect(service.snapshot().conversation!.messages).toEqual([])
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
