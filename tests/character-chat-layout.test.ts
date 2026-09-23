import {expect, it} from 'vitest'
import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ChatWindowLayout, defaultChatWindowPreferences, parseChatWindowPreferences} from '../electron/main/character-chat/ChatWindowLayout'
import {positionRelativeBubble} from '../electron/shared/bubble-placement'

it('remembers user placement relative to the pet, with size, across reopening', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat-layout-'))
  try {
    const layout = new ChatWindowLayout(join(root, 'window.json'))
    await layout.load()
    const pet = {x: 1000, y: 550, width: 400, height: 400}
    const box = {x: 420, y: 280, width: 560, height: 640}
    layout.remember(pet, box)
    await layout.save()
    const reopened = new ChatWindowLayout(layout.file)
    await reopened.load()
    expect(reopened.value).toEqual(layout.value)
    const area = {x: 0, y: 0, width: 1920, height: 1080}
    expect(positionRelativeBubble(pet, area, reopened.value.size, reopened.value.placement)).toEqual(box)
    expect(positionRelativeBubble({...pet, x: pet.x + 70}, area, reopened.value.size, reopened.value.placement)).toEqual({...box, x: box.x + 70})
    const saved = structuredClone(reopened.value)
    const smallScreen = {x: 0, y: 0, width: 480, height: 600}
    const clamped = positionRelativeBubble(pet, smallScreen, reopened.value.size, reopened.value.placement)
    expect(clamped.x + clamped.width).toBeLessThanOrEqual(480)
    expect(clamped.y + clamped.height).toBeLessThanOrEqual(600)
    expect(reopened.value).toEqual(saved)
    reopened.reset()
    await reopened.save()
    await layout.load()
    expect(layout.value).toEqual(defaultChatWindowPreferences())
  } finally { await rm(root, {recursive: true, force: true}) }
})

it.each([
  {version: 2},
  {...defaultChatWindowPreferences(), size: {width: NaN, height: 500}},
  {...defaultChatWindowPreferences(), size: {width: 340, height: 500}},
  {...defaultChatWindowPreferences(), size: {width: 50000, height: 500}},
  {...defaultChatWindowPreferences(), placement: {schemaVersion: 1, mode: 'relative', offsetX: Infinity, offsetY: 1, pivotX: .5, pivotY: .5}},
])('rejects invalid/off-range saved geometry %j', value => {
  expect(parseChatWindowPreferences(value)).toBeNull()
})

it('recovers malformed preferences and saves successive changes in order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat-layout-'))
  try {
    const layout = new ChatWindowLayout(join(root, 'window.json'))
    await writeFile(layout.file, 'invalid')
    await layout.load()
    expect(layout.value).toEqual(defaultChatWindowPreferences())
    const pet = {x: 900, y: 400, width: 400, height: 400}
    layout.remember(pet, {x: 200, y: 200, width: 500, height: 500})
    const first = layout.save()
    layout.remember(pet, {x: 300, y: 300, width: 600, height: 650})
    const second = layout.save()
    await Promise.all([first, second])
    const reopened = new ChatWindowLayout(layout.file)
    await reopened.load()
    expect(reopened.value).toEqual(layout.value)
  } finally { await rm(root, {recursive: true, force: true}) }
})
