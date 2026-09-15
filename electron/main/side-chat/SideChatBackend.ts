import { SIDE_CHAT_OUTPUT_SCHEMA, type ChatResponse } from "../../shared/side-chat-contract"
import type { ChatAuthTokens } from "./SideChatAuth"
import type { ChatParentContext } from "./SideChatParent"
import { SideChatItemCollector } from "./SideChatItemCollector"
import type { CompiledPersona } from "./PersonaCompiler"
import type { AppServerJsonlClient } from "../../../adapter/codex/app-server/AppServerJsonlClient"

export type ChatParent = { threadId: string; title: string; cwd: string; path?: string; sourceHome?: string }
export type ForkContext = { threadId: string; lastTurnId: string; contextAt: number }
export interface SideChatBackend {
  open(parent: ChatParent, persona: CompiledPersona): Promise<ForkContext>
  send(text: string, observation?: { state: string; checkedAt: number | null }): Promise<ChatResponse>
  stop(): Promise<void>
  close(): Promise<void>
}
export type ChatExecutionProfile = { cwd: string; model: string; instructions: "fork" | "collaboration-mode"; noEnvironment: boolean }
export type ChatConnection = { refreshAuth?: () => Promise<ChatAuthTokens>; parentContext?: (parent: ChatParent) => Promise<ChatParentContext>; execution?: ChatExecutionProfile; client: AppServerJsonlClient; stop(): Promise<void> }
type ActiveSend = {
  generation: number; connection: ChatConnection; child: string; turnId: string | null
  collector: SideChatItemCollector; timer: ReturnType<typeof setTimeout>; settle: (value: ChatResponse | Error) => void
}
const object = (v: unknown): Record<string, any> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : {}

/** Owns exactly one child. Never resume, send to, interrupt or archive a parent. */
export class CodexSideChatBackend implements SideChatBackend {
  private connection: ChatConnection | null = null
  private child: string | null = null
  private persona: CompiledPersona | null = null
  private generation = 0
  private active: ActiveSend | null = null
  private cleanup: Array<() => void> = []
  constructor(private readonly connect: () => Promise<ChatConnection>, private readonly owned: (id: string) => void | Promise<void> = () => {}) {}
  async open(parent: ChatParent, persona: CompiledPersona): Promise<ForkContext> {
    const generation = ++this.generation
    const connection = await this.connect()
    if (generation !== this.generation) { await connection.stop(); throw new Error("SESSION_LOST") }
    this.connection = connection; this.persona = persona
    const client = connection.client
    const current = () => generation === this.generation && connection === this.connection
    this.cleanup.push(client.onClose(() => {
      if (!current()) return
      const request = this.active
      if (request) this.finish(request, new Error(request.turnId ? "OUTCOME_UNKNOWN" : "SESSION_LOST"))
      void this.close()
    }))
    this.cleanup.push(client.onServerRequest(request => {
      if (!current()) return
      if (request.method === "account/chatgptAuthTokens/refresh" && connection.refreshAuth) {
        void connection.refreshAuth().then(tokens => { if (current()) return client.respondToServerRequest(request.id, tokens) }).catch(() => {
          if (!current()) return
          void client.rejectServerRequest(request.id).catch(() => {})
          if (this.active) this.finish(this.active, new Error("CHAT_AUTH_REQUIRED"))
          void this.close()
        })
        return
      }
      // Defense in depth: the policy gate must prevent tools before this point.
      void client.rejectServerRequest(request.id).catch(() => {})
      if (this.active) this.finish(this.active, new Error("CHAT_POLICY_UNENFORCEABLE"))
      void this.close()
    }))
    this.cleanup.push(client.onNotification((method, params) => { if (current()) this.notification(method, params) }))
    if (client.handshakeState !== "READY") await client.initialize({ name: "daemonlet_side_chat", title: "Daemonlet side chat", version: "1" }, "side-chat")
    if (!current()) throw new Error("SESSION_LOST")
    let context: Omit<ChatParentContext, "path"> & { path?: string }
    if (connection.parentContext) context = await connection.parentContext(parent)
    else {
      const metadata = object(object(await client.request("thread/read", { threadId: parent.threadId, includeTurns: false })).thread)
      if (!current()) throw new Error("SESSION_LOST")
      const page = object(await client.request("thread/turns/list", { threadId: parent.threadId, limit: 100, sortDirection: "desc" }))
      if (!current()) throw new Error("SESSION_LOST")
      const turns = Array.isArray(page.data) ? page.data : []
      const last = turns.map(object).find(t => typeof t.id === "string" && ["completed", "interrupted", "failed"].includes(t.status))
      if (!last) throw new Error("NO_PARENT")
      context = { lastTurnId: last.id, contextAt: typeof last.completedAt === "number" ? last.completedAt * 1000 : typeof metadata.updatedAt === "number" ? metadata.updatedAt * 1000 : Date.now() }
    }
    if (!current()) throw new Error("SESSION_LOST")
    const result = object(await client.request("thread/fork", { threadId: parent.threadId, ...(context.path ? { path: context.path } : {}), ...(connection.execution ? { model: connection.execution.model } : {}), lastTurnId: context.lastTurnId, ephemeral: true, excludeTurns: true, cwd: connection.execution?.cwd ?? parent.cwd, approvalPolicy: "never", sandbox: "read-only", developerInstructions: persona.developerInstructions }))
    const child = object(result.thread)
    if (generation !== this.generation) throw new Error("SESSION_LOST")
    if (typeof child.id !== "string" || child.id === parent.threadId || child.ephemeral !== true) throw new Error("CHAT_POLICY_UNENFORCEABLE")
    this.child = child.id; await this.owned(child.id)
    if (!current()) throw new Error("SESSION_LOST")
    return { threadId: child.id, lastTurnId: context.lastTurnId, contextAt: context.contextAt }
  }
  private owns(request: ActiveSend): boolean {
    return this.active === request && request.generation === this.generation && request.connection === this.connection && request.child === this.child
  }
  private finish(request: ActiveSend, value: ChatResponse | Error): void {
    if (!this.owns(request)) return
    clearTimeout(request.timer); this.active = null; request.settle(value)
  }
  private failAndClose(request: ActiveSend, code: string): void {
    if (!this.owns(request)) return
    this.finish(request, new Error(code)); void this.close()
  }
  async send(text: string, observation?: { state: string; checkedAt: number | null }): Promise<ChatResponse> {
    if (!this.connection || !this.child || !this.persona) throw new Error("SESSION_LOST")
    if (this.active) throw new Error("BUSY")
    const connection = this.connection, child = this.child, generation = this.generation
    let settle!: ActiveSend["settle"]
    const result = new Promise<ChatResponse>((resolve, reject) => {
      settle = value => value instanceof Error ? reject(value) : resolve(value)
    })
    const request: ActiveSend = { connection, child, generation, turnId: null, settle, collector: new SideChatItemCollector(),
      timer: setTimeout(() => this.failAndClose(request, "OUTCOME_UNKNOWN"), 180_000) }
    request.timer.unref(); this.active = request
    // Notifications may finish A before its RPC response. Every continuation still owns only A.
    const execution = connection.execution
    const policy = execution ? { ...(execution.noEnvironment ? { environments: [] } : {}),
      ...(execution.instructions === "collaboration-mode" ? { collaborationMode: { mode: "default", settings: { model: execution.model, reasoning_effort: null, developer_instructions: this.persona.developerInstructions } } } : {}) } : {}
    void connection.client.request("turn/start", { ...policy, threadId: child, input: [{ type: "text", text: `${this.persona.profileInput}\n\nApp-observed parent status (not history): ${JSON.stringify(observation ?? { state: "unknown", checkedAt: null })}\n\nUser message:\n${text}`, text_elements: [] }], outputSchema: SIDE_CHAT_OUTPUT_SCHEMA }).then(value => {
      if (!this.owns(request)) return
      const turn = object(object(value).turn)
      if (typeof turn.id !== "string" || request.turnId && request.turnId !== turn.id) this.failAndClose(request, "OUTCOME_UNKNOWN")
      else request.turnId = turn.id
    }).catch(() => this.failAndClose(request, "OUTCOME_UNKNOWN"))
    return result
  }
  private notification(method: string, value: unknown) {
    const p = object(value), turn = object(p.turn), request = this.active
    if (p.threadId !== this.child) return
    if (method === "thread/closed") {
      if (request) this.finish(request, new Error("SESSION_LOST"))
      void this.close(); return
    }
    if (!request || !this.owns(request)) return
    if (method === "turn/started" && typeof turn.id === "string" && !request.turnId) request.turnId = turn.id
    if (p.turnId === request.turnId && request.turnId && (method === "item/started" || method === "item/completed")) {
      try { method === "item/started" ? request.collector.start(p.item) : request.collector.complete(p.item) }
      catch (error) { this.failAndClose(request, error instanceof Error ? error.message : "RESPONSE_INVALID") }
      return
    }
    if (method !== "turn/completed" || !request.turnId || turn.id !== request.turnId) return
    if (turn.status === "interrupted") { this.finish(request, new Error("STOPPED")); return }
    if (turn.status !== "completed") { this.finish(request, new Error("SESSION_LOST")); return }
    try { this.finish(request, request.collector.finish(turn.items)) }
    catch (error) { this.finish(request, error instanceof Error ? error : new Error("RESPONSE_INVALID")) }
  }

  async stop(): Promise<void> {
    const request = this.active
    if (!request || !this.owns(request)) return
    const turnId = request.turnId
    if (!turnId) { this.failAndClose(request, "OUTCOME_UNKNOWN"); return }
    try {
      await request.connection.client.request("turn/interrupt", { threadId: request.child, turnId })
      this.finish(request, new Error("STOPPED"))
    } catch { this.failAndClose(request, "OUTCOME_UNKNOWN") }
  }
  async close(): Promise<void> {
    if (this.active) this.finish(this.active, new Error("SESSION_LOST"))
    this.generation++
    for (const unsubscribe of this.cleanup.splice(0)) unsubscribe()
    const connection = this.connection; this.connection = null; this.child = null; this.persona = null
    await connection?.stop()
  }
}
