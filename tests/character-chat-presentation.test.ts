import {afterEach, beforeEach, expect, it, vi} from 'vitest'
import {ChatPresentationController, CHAT_PREPARATION_DELAY_MS, CHAT_PREPARATION_HOLD_MS} from '../src/character-chat/ChatPresentationController'
import {neutralMeaning, validateChatDefinition} from '../electron/shared/character-chat-semantics'
import type {LocalChatPresentation} from '../electron/shared/character-chat-contract'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function fixture() {
  let pose: string | null = null
  const runtime = {
    getPoseDiagnostics: () => ({id: pose}), setChatMotionPolicy: vi.fn(),
    transitionToPose: vi.fn(async (id: string, _options: unknown) => {pose = id}),
    exitPose: vi.fn(async (_options: unknown) => {pose = null}),
    resetPose: vi.fn(), getBaseFaceGeometry: () => null,
  }
  const session = {runtime, behavior: {setControlMode: vi.fn(), setPresentationSuspended: vi.fn()},
    setInteractionEnabled: vi.fn(), dialogue: {setEnabled: vi.fn(), clear: vi.fn()}}
  const controller = new ChatPresentationController(session as any)
  const definition = validateChatDefinition({schemaVersion: 1, presentation: {rules: [
    {id: 'prepare', poseId: 'p17', when: {phase: 'generating'}, motionPolicy: 'chat-safe'},
    {id: 'concern', poseId: 'p29', when: {phase: 'replying', emotion: 'concerned'}, motionPolicy: 'chat-safe'},
  ]}}, ['p17', 'p29'], true).value
  const p: LocalChatPresentation = {active: true, epoch: 1, characterId: 'example', revision: 'r1', phase: 'generating', meaning: null, definition}
  const update = (patch: Partial<LocalChatPresentation> = {}) => controller.update({...p, ...patch}, 'example', 'r1')
  const meaning = {...neutralMeaning(), emotion: 'concerned' as const}
  return {runtime, controller, update, meaning}
}

it('skips preparation when text arrives before the delay, even if metadata arrives much later', async () => {
  const {runtime, controller, update, meaning} = fixture()
  update()
  await vi.advanceTimersByTimeAsync(CHAT_PREPARATION_DELAY_MS - 1)
  update({phase: 'replying'})
  await vi.advanceTimersByTimeAsync(3000)
  expect(runtime.transitionToPose).not.toHaveBeenCalled()
  expect(runtime.exitPose).not.toHaveBeenCalled()
  update({phase: 'idle', meaning})
  await vi.advanceTimersByTimeAsync(0)
  expect(runtime.transitionToPose.mock.calls.map(c => c[0])).toEqual(['p29'])
  controller.dispose()
})

it('holds a visible preparation pose, then goes directly to the reply without a base interlude', async () => {
  const {runtime, controller, update, meaning} = fixture()
  update()
  await vi.advanceTimersByTimeAsync(CHAT_PREPARATION_DELAY_MS)
  expect(runtime.getPoseDiagnostics().id).toBe('p17')
  update({phase: 'replying'})
  update({phase: 'idle', meaning})
  await vi.advanceTimersByTimeAsync(CHAT_PREPARATION_HOLD_MS - 1)
  expect(runtime.getPoseDiagnostics().id).toBe('p17')
  await vi.advanceTimersByTimeAsync(1)
  expect(runtime.getPoseDiagnostics().id).toBe('p29')
  expect(runtime.exitPose).not.toHaveBeenCalled()
  update({phase: 'attentive', meaning})
  await vi.advanceTimersByTimeAsync(60000)
  update({phase: 'idle', meaning})
  expect(runtime.transitionToPose.mock.calls.map(c => c[0])).toEqual(['p17', 'p29'])
  controller.dispose()
})

it('starts minimum visibility after asynchronous pose entry completes', async () => {
  const {runtime, controller, update, meaning} = fixture()
  let finishEntry!: () => void
  runtime.transitionToPose.mockImplementationOnce(async () => new Promise<void>(resolve => {finishEntry = resolve}))
  update()
  await vi.advanceTimersByTimeAsync(CHAT_PREPARATION_DELAY_MS)
  update({phase: 'idle', meaning})
  await vi.advanceTimersByTimeAsync(2000)
  expect(runtime.transitionToPose).toHaveBeenCalledTimes(1)
  finishEntry()
  await vi.advanceTimersByTimeAsync(CHAT_PREPARATION_HOLD_MS - 1)
  expect(runtime.transitionToPose).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(runtime.transitionToPose.mock.calls.map(c => c[0])).toEqual(['p17', 'p29'])
  controller.dispose()
})

it('cancellation immediately clears preparation and prevents a delayed reply from resurfacing', async () => {
  const {runtime, controller, update, meaning} = fixture()
  update()
  await vi.advanceTimersByTimeAsync(CHAT_PREPARATION_DELAY_MS)
  update({phase: 'idle', meaning})
  await vi.advanceTimersByTimeAsync(50)
  update({epoch: 2, phase: 'idle'})
  await vi.advanceTimersByTimeAsync(5000)
  expect(runtime.getPoseDiagnostics().id).toBeNull()
  expect(runtime.transitionToPose.mock.calls.map(c => c[0])).toEqual(['p17'])
  controller.dispose()
})

it('errors and closing cancel an unfinished preparation transition in the same epoch', async () => {
  const {runtime, controller, update, meaning} = fixture()
  let finishEntry!: () => void
  runtime.transitionToPose.mockImplementationOnce(async () => new Promise<void>(resolve => {finishEntry = resolve}))
  update()
  await vi.advanceTimersByTimeAsync(CHAT_PREPARATION_DELAY_MS)
  update({phase: 'idle', meaning})
  update({phase: 'idle'})
  update({active: false, phase: 'idle'})
  finishEntry()
  await vi.advanceTimersByTimeAsync(5000)
  expect(runtime.transitionToPose.mock.calls.map(c => c[0])).toEqual(['p17'])
  controller.dispose()
})
