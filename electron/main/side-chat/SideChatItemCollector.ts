import { parseChatResponse, SIDE_CHAT_LIMITS, utf8Bytes, type ChatResponse } from "../../shared/side-chat-contract"

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
export const CHAT_ITEM_LIMITS = { count: 64, itemBytes: SIDE_CHAT_LIMITS.responseBytes * 6, turnBytes: SIDE_CHAT_LIMITS.responseBytes * 12 } as const
type Message = { phase: "commentary" | "final_answer" | null; text: string }

/** One active turn owns this collector. No deltas, reasoning or tool output are retained. */
export class SideChatItemCollector {
  private started = new Set<string>()
  private completed = new Map<string, Message>()
  private bytes = 0
  private refused = false
  private id(value: unknown): string {
    if (typeof value !== "string" || !value || utf8Bytes(value) > 256) throw Error("RESPONSE_INVALID")
    return value
  }
  start(value: unknown): void {
    const item = object(value)
    if (item.type === "refusal") { this.refused = true; return }
    if (item.type !== "agentMessage") return
    const id = this.id(item.id)
    this.started.add(id)
    if (this.started.size > CHAT_ITEM_LIMITS.count) throw Error("RESPONSE_LIMIT")
  }
  complete(value: unknown, fallback = false): void {
    const item = object(value)
    if (item.type === "refusal") { this.refused = true; return }
    if (item.type !== "agentMessage") return
    const id = this.id(item.id)
    if (!fallback && !this.started.has(id)) return
    if (fallback) this.start(item)
    if (typeof item.text !== "string" || ![undefined, null, "commentary", "final_answer"].includes(item.phase as any)) throw Error("RESPONSE_INVALID")
    const message: Message = { phase: item.phase as Message["phase"] ?? null, text: item.text }
    const old = this.completed.get(id)
    if (old) {
      if (old.text !== message.text || old.phase !== message.phase) throw Error("RESPONSE_INVALID")
      return
    }
    const size = utf8Bytes(item.text)
    if (size > CHAT_ITEM_LIMITS.itemBytes || this.bytes + size > CHAT_ITEM_LIMITS.turnBytes) throw Error("RESPONSE_LIMIT")
    this.bytes += size; this.completed.set(id, message)
  }
  finish(items: unknown): ChatResponse {
    if (Array.isArray(items)) {
      if (items.length > CHAT_ITEM_LIMITS.count) throw Error("RESPONSE_LIMIT")
      for (const item of items) this.complete(item, true)
    }
    if (this.refused) throw Error("REFUSED")
    const messages = [...this.completed.values()]
    const explicit = messages.filter(item => item.phase === "final_answer")
    const answers = explicit.length ? explicit : messages.filter(item => item.phase === null)
    if (answers.length !== 1) throw Error("RESPONSE_INVALID")
    return parseChatResponse(answers[0].text)
  }
}
