import {replaceFile} from './replaceFile'
import {mkdir, readFile,  writeFile, stat, rm} from 'node:fs/promises'
import {dirname} from 'node:path'
import {randomUUID} from 'node:crypto'
import {automaticBubblePlacement, parseBubblePlacement, relativeBubblePlacement, type BubblePlacement} from '../../shared/bubble-placement'

export const CHAT_WINDOW_SIZE = {width: 410, height: 500}
export const CHAT_WINDOW_MIN = {width: 350, height: 360}
export const CHAT_WINDOW_MAX = {width: 1200, height: 1200}
type Rect = {x: number; y: number; width: number; height: number}
export type ChatWindowPreferences = {version: 1; placement: BubblePlacement; size: {width: number; height: number}}
export const defaultChatWindowPreferences = (): ChatWindowPreferences => ({version: 1, placement: automaticBubblePlacement(), size: {...CHAT_WINDOW_SIZE}})

export function resizeChatBounds(start: Rect, dx: number, dy: number): Rect {
  return {...start,
    width: Math.max(CHAT_WINDOW_MIN.width, Math.min(CHAT_WINDOW_MAX.width, Math.round(start.width + dx))),
    height: Math.max(CHAT_WINDOW_MIN.height, Math.min(CHAT_WINDOW_MAX.height, Math.round(start.height + dy))),
  }
}

export function parseChatWindowPreferences(value: unknown): ChatWindowPreferences | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (v.version !== 1 || Object.keys(v).sort().join() !== 'placement,size,version') return null
  const placement = parseBubblePlacement(v.placement)
  const size = v.size as Record<string, unknown> | undefined
  if (!placement || !size || typeof size !== 'object' || Array.isArray(size) || Object.keys(size).sort().join() !== 'height,width') return null
  const {width, height} = size
  if (typeof width !== 'number' || !Number.isInteger(width) || width < CHAT_WINDOW_MIN.width || width > CHAT_WINDOW_MAX.width ||
      typeof height !== 'number' || !Number.isInteger(height) || height < CHAT_WINDOW_MIN.height || height > CHAT_WINDOW_MAX.height) return null
  return {version: 1, placement, size: {width, height}}
}

/** Only explicit native user movement/resizing is recorded, never display clamping. */
export class ChatWindowLayout {
  value = defaultChatWindowPreferences()
  private saves = Promise.resolve()
  private loaded = false
  private revision = 0
  private savedRevision = 0
  constructor(readonly file: string) {}
  async load() {
    this.loaded=false
    try {
      if ((await stat(this.file)).size > 16384) {this.loaded=true;return}
      const bytes = await readFile(this.file)
      if (bytes.length <= 16384) this.value = parseChatWindowPreferences(JSON.parse(bytes.toString('utf8'))) ?? defaultChatWindowPreferences()
    } catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code!=='ENOENT') throw error
      this.value = defaultChatWindowPreferences()
    }
    this.loaded=true
  }
  remember(pet: Rect, box: Rect) {
    const next = parseChatWindowPreferences({version: 1, placement: relativeBubblePlacement(pet, box), size: {
      width: Math.max(CHAT_WINDOW_MIN.width, Math.min(CHAT_WINDOW_MAX.width, Math.round(box.width))),
      height: Math.max(CHAT_WINDOW_MIN.height, Math.min(CHAT_WINDOW_MAX.height, Math.round(box.height))),
    }})
    if (this.loaded && next) {this.value = next;this.revision++}
  }
  reset() { if(this.loaded){this.value = defaultChatWindowPreferences();this.revision++} }
  save() {
    if(!this.loaded || this.revision===this.savedRevision)return this.saves
    const revision=this.revision
    const bytes = JSON.stringify(this.value)
    const next = this.saves.catch(() => {}).then(async () => {
      await mkdir(dirname(this.file), {recursive: true, mode: 0o700})
      const temp = this.file + '.tmp-' + randomUUID()
      try {
        await writeFile(temp, bytes, {mode: 0o600})
        await replaceFile(temp, this.file)
      } finally {await rm(temp,{force:true}).catch(()=>{})}
      this.savedRevision=revision
    })
    this.saves = next
    return next
  }
}
