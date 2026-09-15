import { SIDE_CHAT_OUTPUT_SCHEMA, parseChatResponse, type ChatResponse } from "../../shared/side-chat-contract"
import type { CompiledPersona } from "./PersonaCompiler"
import type { AppServerJsonlClient } from "../../../adapter/codex/app-server/AppServerJsonlClient"

export type ChatParent = { threadId: string; title: string; cwd: string }
export type ForkContext = { threadId: string; lastTurnId: string; contextAt: number }
export interface SideChatBackend {
  open(parent: ChatParent, persona: CompiledPersona): Promise<ForkContext>
  send(text: string, observation?: { state: string; checkedAt: number | null }): Promise<ChatResponse>
  stop(): Promise<void>
  close(): Promise<void>
}
export type ChatConnection = { client: AppServerJsonlClient; stop(): Promise<void> }
const object = (v: unknown): Record<string, any> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : {}

/** Owns exactly one child. Never resume, send to, interrupt or archive a parent. */
export class CodexSideChatBackend implements SideChatBackend {
  private connection: ChatConnection | null = null
  private child: string | null = null
  private turn: string | null = null
  private persona: CompiledPersona | null = null
  private generation = 0
  private finished: ((value: ChatResponse | Error) => void) | null = null
  private cleanup: Array<() => void> = []
  constructor(private readonly connect: () => Promise<ChatConnection>, private readonly owned: (id: string) => void | Promise<void> = () => {}) {}
  async open(parent: ChatParent, persona: CompiledPersona): Promise<ForkContext> {
    const generation = ++this.generation
    const connection = await this.connect()
    if (generation !== this.generation) { await connection.stop(); throw new Error("SESSION_LOST") }
    this.connection = connection; this.persona = persona
    const client = connection.client
    this.cleanup.push(client.onClose(() => this.finished?.(new Error(this.turn ? "OUTCOME_UNKNOWN" : "SESSION_LOST"))))
    this.cleanup.push(client.onServerRequest(request => {
      // Defense in depth: the policy gate must prevent tools before this point.
      void client.rejectServerRequest(request.id).catch(() => {})
      this.finished?.(new Error("CHAT_POLICY_UNENFORCEABLE"))
      void this.close()
    }))
    this.cleanup.push(client.onNotification((method, params) => this.notification(method, params)))
    await client.initialize({ name: "daemonlet_side_chat", title: "Daemonlet side chat", version: "1" }, "side-chat")
    const metadata = object(object(await client.request("thread/read", { threadId: parent.threadId, includeTurns: false })).thread)
    // Page newest first; choose a terminal turn, never an in-progress boundary.
    const page = object(await client.request("thread/turns/list", { threadId: parent.threadId, limit: 100, sortDirection: "desc" }))
    const turns = Array.isArray(page.data) ? page.data : []
    const last = turns.map(object).find(t => typeof t.id === "string" && ["completed", "interrupted", "failed"].includes(t.status))
    if (!last) throw new Error("NO_PARENT")
    const result = object(await client.request("thread/fork", { threadId: parent.threadId, lastTurnId: last.id, ephemeral: true, excludeTurns: true, cwd: parent.cwd, approvalPolicy: "never", sandbox: "read-only", developerInstructions: persona.developerInstructions }))
    const child = object(result.thread)
    if (generation !== this.generation) throw new Error("SESSION_LOST")
    if (typeof child.id !== "string" || child.id === parent.threadId || child.ephemeral !== true) throw new Error("CHAT_POLICY_UNENFORCEABLE")
    this.child = child.id; await this.owned(child.id)
    return { threadId: child.id, lastTurnId: last.id, contextAt: typeof last.completedAt === "number" ? last.completedAt * 1000 : typeof metadata.updatedAt === "number" ? metadata.updatedAt * 1000 : Date.now() }
  }
  async send(text: string, observation?: { state: string; checkedAt: number | null }): Promise<ChatResponse> {
    if (!this.connection || !this.child || !this.persona) throw new Error("SESSION_LOST")
    if (this.finished) throw new Error("BUSY")
    const client = this.connection.client, child = this.child
    let accepted = false
    const result = new Promise<ChatResponse>((resolve, reject) => {
      const timeout = setTimeout(() => { this.finished?.(new Error("OUTCOME_UNKNOWN")); void this.close() }, 180_000)
      timeout.unref()
      this.finished = value => { clearTimeout(timeout); this.finished = null; this.turn = null; value instanceof Error ? reject(value) : resolve(value) }
    })
    // Notifications can arrive before the start response. Matching is by owned child and turn.
    void client.request("turn/start", { threadId: child, input: [{ type: "text", text: `${this.persona.profileInput}\n\nApp-observed parent status (not history): ${JSON.stringify(observation ?? { state: "unknown", checkedAt: null })}\n\nUser message:\n${text}`, text_elements: [] }], outputSchema: SIDE_CHAT_OUTPUT_SCHEMA }).then(value => {
      accepted = true
      const turn = object(object(value).turn)
      if (this.finished && this.child === child) {
        if (typeof turn.id !== "string") this.finished(new Error("OUTCOME_UNKNOWN"))
        else if (!this.turn) this.turn = turn.id
      }
    }).catch(() => { this.finished?.(new Error(accepted ? "SESSION_LOST" : "OUTCOME_UNKNOWN")); void this.close() })
    return result
  }
  private notification(method: string, value: unknown) {
    const p = object(value), turn = object(p.turn)
    if (p.threadId !== this.child) return
    if (method === "thread/closed") { this.finished?.(new Error("SESSION_LOST")); void this.close(); return }
    if (!this.finished) return
    if (method === "turn/started" && typeof turn.id === "string" && !this.turn) this.turn = turn.id
    if (method !== "turn/completed" || !this.turn || turn.id !== this.turn) return
    if (turn.status === "interrupted") { this.finished(new Error("STOPPED")); return }
    if (turn.status !== "completed") { this.finished(new Error("SESSION_LOST")); return }
    const items = Array.isArray(turn.items) ? turn.items.map(object) : []
    if (items.some(i => i.type === "refusal")) { this.finished(new Error("REFUSED")); return }
    const answers = items.filter(i => i.type === "agentMessage" && (i.phase === "final_answer" || !i.phase))
    try { if (answers.length !== 1 || typeof answers[0].text !== "string") throw new Error("RESPONSE_INVALID"); this.finished(parseChatResponse(answers[0].text)) }
    catch { this.finished?.(new Error("RESPONSE_INVALID")) }
  }
  async stop(): Promise<void> {
    if (!this.connection || !this.child) return
    if (!this.turn) { this.finished?.(new Error("OUTCOME_UNKNOWN")); await this.close(); return }
    try { await this.connection.client.request("turn/interrupt", { threadId: this.child, turnId: this.turn }); this.finished?.(new Error("STOPPED")) }
    catch { this.finished?.(new Error("OUTCOME_UNKNOWN")); await this.close() }
  }
  async close(): Promise<void> {
    this.generation++
    this.finished?.(new Error("SESSION_LOST"))
    for (const unsubscribe of this.cleanup.splice(0)) unsubscribe()
    const connection = this.connection; this.connection = null; this.child = null; this.turn = null; this.persona = null
    await connection?.stop()
  }
}
