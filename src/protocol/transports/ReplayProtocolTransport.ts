import type { ProtocolClientCommand, ProtocolFrame } from "../types"
import type { CharacterEventTransport, TransportStatus } from "./CharacterEventTransport"

export type ReplayEntry = { raw: string; at: number }

export class ReplayProtocolTransport implements CharacterEventTransport {
  readonly endpoint = "replay://local-trace"
  private entries: ReplayEntry[] = []
  private index = 0
  private speed = 1
  private timer: ReturnType<typeof setTimeout> | null = null
  private playing = false
  private status: TransportStatus = { state: "DISCONNECTED" }
  private readonly messageListeners = new Set<(raw: string | ArrayBuffer) => void>()
  private readonly statusListeners = new Set<(status: TransportStatus) => void>()

  async connect(): Promise<void> {
    if (this.status.state === "OPEN") return
    this.setStatus({ state: "CONNECTING" })
    await Promise.resolve()
    this.setStatus({ state: "OPEN" })
  }

  disconnect(reason = "manual disconnect"): void {
    this.pause()
    this.setStatus({ state: "CLOSED", reason, manual: true })
  }

  send(_command: ProtocolClientCommand): void {
    if (this.status.state !== "OPEN") throw new Error("replay transport is not open")
  }

  load(input: string | ProtocolFrame[] | ReplayEntry[]): void {
    const entries = this.parseEntries(input)
    this.pause()
    this.index = 0
    this.entries = entries
  }

  play(): void {
    if (this.playing || this.index >= this.entries.length || this.status.state !== "OPEN") return
    this.playing = true
    this.scheduleNext(0)
  }

  pause(): void {
    this.playing = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  step(): boolean {
    if (this.index >= this.entries.length || this.status.state !== "OPEN") return false
    this.emit(this.entries[this.index++].raw)
    return true
  }

  reset(): void {
    this.pause()
    this.index = 0
  }

  setSpeed(speed: 0.5 | 1 | 2): void {
    this.speed = speed
  }

  getPlaybackState() {
    return { index: this.index, count: this.entries.length, playing: this.playing, speed: this.speed }
  }

  subscribeMessage(listener: (raw: string | ArrayBuffer) => void): () => void {
    this.messageListeners.add(listener)
    return () => this.messageListeners.delete(listener)
  }

  subscribeStatus(listener: (status: TransportStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  getStatus(): TransportStatus {
    return { ...this.status }
  }

  dispose(): void {
    this.pause()
    this.setStatus({ state: "CLOSED", reason: "disposed", manual: true })
    this.messageListeners.clear()
    this.statusListeners.clear()
  }

  private scheduleNext(delay: number): void {
    this.timer = setTimeout(() => {
      this.timer = null
      if (!this.playing || !this.step()) {
        this.playing = false
        return
      }
      const previous = this.entries[this.index - 1]
      const next = this.entries[this.index]
      this.scheduleNext(next ? Math.max(0, next.at - previous.at) / this.speed : 0)
    }, delay)
  }

  private emit(raw: string): void {
    for (const listener of this.messageListeners) listener(raw)
  }

  private parseEntries(input: string | ProtocolFrame[] | ReplayEntry[]): ReplayEntry[] {
    if (typeof input !== "string") return input.map((item, index) => this.parseEntry(item, index))
    const trimmed = input.trim()
    if (!trimmed) return []
    let values: unknown[]
    try {
      const parsed = JSON.parse(trimmed) as unknown
      values = Array.isArray(parsed) ? parsed : [parsed]
    } catch (jsonError) {
      const lines = trimmed.split(/\r?\n/).filter((line) => line.trim().length > 0)
      try {
        values = lines.map((line) => JSON.parse(line) as unknown)
      } catch (jsonlError) {
        const message = jsonlError instanceof Error ? jsonlError.message : String(jsonlError)
        throw new Error(`Replay is neither valid JSON nor JSONL: ${message}`, { cause: jsonError })
      }
    }
    return values.map((value, index) => this.parseEntry(value, index))
  }

  private parseEntry(value: unknown, index: number): ReplayEntry {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`Replay entry ${index + 1} must be an object`)
    if ("raw" in value) {
      const entry = value as { raw?: unknown; at?: unknown }
      if (typeof entry.raw !== "string") throw new Error(`Replay entry ${index + 1} raw must be a string`)
      if (entry.at !== undefined && (typeof entry.at !== "number" || !Number.isFinite(entry.at) || entry.at < 0)) throw new Error(`Replay entry ${index + 1} at must be a finite non-negative number`)
      return { raw: entry.raw, at: entry.at ?? index }
    }
    const sentAt = "sentAt" in value ? (value as { sentAt?: unknown }).sentAt : undefined
    if (sentAt !== undefined && (typeof sentAt !== "number" || !Number.isFinite(sentAt) || sentAt < 0)) throw new Error(`Replay entry ${index + 1} sentAt must be a finite non-negative number`)
    return { raw: JSON.stringify(value), at: sentAt ?? index }
  }

  private setStatus(status: TransportStatus): void {
    this.status = status
    for (const listener of this.statusListeners) listener({ ...status })
  }
}
