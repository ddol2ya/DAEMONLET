import { SIDE_CHAT_OUTPUT_SCHEMA, type ChatResponse, type ChatSourceReadiness } from "../../shared/side-chat-contract"
import type { ChatAuthTokens } from "./SideChatAuth"
import type { ChatParentContext } from "./SideChatParent"
import { validateSourceSnapshot, type ChatParentSource } from "./SideChatSource"
import { SideChatItemCollector } from "./SideChatItemCollector"
import type { CompiledPersona } from "./PersonaCompiler"
import type { AppServerJsonlClient } from "../../../adapter/codex/app-server/AppServerJsonlClient"
import { resolveOfficialParent } from "./OfficialParentResolver"

export type ChatParent = { threadId: string; title: string; cwd: string; path?: string; sourceHome?: string; source?: ChatSourceReadiness }
export type ForkContext = { threadId: string; lastTurnId: string; contextAt: number }
export type ChatSessionClosed = { error: Error; hadSession: boolean }
export interface SideChatBackend {
  isSessionOpen(): boolean
  onSessionClosed(listener: (event: ChatSessionClosed) => void): () => void
  open(parent: ChatParent, persona: CompiledPersona): Promise<ForkContext>
  prepareSend?(): Promise<void>
  send(text: string, observation?: { state: string; checkedAt: number | null }): Promise<ChatResponse>
  stop(): Promise<void>
  close(): Promise<void>
}
export type ChatExecutionProfile = { mode?: "official-same-home"; cwd: string; model: string; instructions: "fork" | "collaboration-mode"; noEnvironment: boolean }
export type ChatConnection = { beforeTurn?: () => Promise<void>; refreshAuth?: () => Promise<ChatAuthTokens>; parentContext?: (parent: ChatParent) => Promise<ChatParentSource>; execution?: ChatExecutionProfile; client: AppServerJsonlClient; stop(): Promise<void> }
type ActiveSend = {
  deniedRequests: number
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
  private closing: Promise<void> | null = null
  private closedListeners = new Set<(event: ChatSessionClosed) => void>()
  isSessionOpen() { return Boolean(this.connection && this.child && this.persona) }
  onSessionClosed(listener: (event: ChatSessionClosed) => void) {
    this.closedListeners.add(listener)
    return () => { this.closedListeners.delete(listener) }
  }
  constructor(private readonly connect: () => Promise<ChatConnection>, private readonly owned: (id: string) => void | Promise<void> = () => {}) {}
  async open(parent: ChatParent, persona: CompiledPersona): Promise<ForkContext> {
    const generation = ++this.generation
    if (this.closing) {
      await this.closing
      if (generation !== this.generation) throw new Error("SESSION_LOST")
      this.closing = null
    }
    const connection = await this.connect()
    if (generation !== this.generation) { await connection.stop(); throw new Error("SESSION_LOST") }
    this.connection = connection; this.persona = persona
    const client = connection.client
    const current = () => generation === this.generation && connection === this.connection
    this.cleanup.push(client.onClose(() => {
      if (!current()) return
      const request = this.active
      void this.close(request?.turnId ? "OUTCOME_UNKNOWN" : "SESSION_LOST")
    }))
    this.cleanup.push(client.onServerRequest(request => {
      if (!current()) return
      if (request.method === "account/chatgptAuthTokens/refresh" && connection.refreshAuth) {
        void connection.refreshAuth().then(tokens => { if (current()) return client.respondToServerRequest(request.id, tokens) }).catch(() => {
          if (!current()) return
          void client.rejectServerRequest(request.id).catch(() => {})
          void this.close("CHAT_AUTH_REQUIRED")
        })
        return
      }
      if (connection.execution?.mode === "official-same-home") {
        const p = object(request.params), active = this.active
        if (typeof p.threadId === "string" && (p.threadId !== this.child || !active || p.turnId !== active.turnId)) {
          // A delayed old-turn request must not tear down the current turn.
          void client.rejectServerRequest(request.id).catch(() => {})
          return
        }
        if (active && this.owns(active) && active.turnId && p.threadId === active.child && p.turnId === active.turnId && ++active.deniedRequests <= 8) {
          // Inherited client tools cannot run without our response. Model paths,
          // commands and parent IDs are never forwarded to any executor.
          const responses: Record<string, unknown> = {
            "item/tool/call": { success: false, contentItems: [{ type: "inputText", text: "This read-only companion does not execute tools. Ask the user to select a project file in the attachment control." }] },
            "item/commandExecution/requestApproval": { decision: "decline" },
            "item/fileChange/requestApproval": { decision: "decline" },
            "item/permissions/requestApproval": { permissions: {}, scope: "turn" },
          }
          if (Object.hasOwn(responses, String(request.method))) {
            void client.respondToServerRequest(request.id, responses[String(request.method)]).catch(() => { if (current()) void this.close("CHAT_POLICY_UNENFORCEABLE") })
            return
          }
        }
      }
      // Unknown requests fail closed; no approval UI or general RPC bridge.
      void client.rejectServerRequest(request.id).catch(() => {})
      void this.close("CHAT_POLICY_UNENFORCEABLE")
    }))
    this.cleanup.push(client.onNotification((method, params) => { if (current()) this.notification(method, params) }))
    if (client.handshakeState !== "READY") await client.initialize({ name: "daemonlet_side_chat", title: "Daemonlet side chat", version: "1" }, "side-chat")
    if (!current()) throw new Error("SESSION_LOST")
    let context: ChatParentSource | (Omit<ChatParentContext, "path"> & { path?: string })
    if (connection.execution?.mode === "official-same-home") context = await resolveOfficialParent(client, parent)
    else if (connection.parentContext) context = await connection.parentContext(parent)
    else {
      const metadata = object(object(await client.request("thread/read", { threadId: parent.threadId, includeTurns: false })).thread)
      if (!current()) throw new Error("SESSION_LOST")
      const page = object(await client.request("thread/turns/list", { threadId: parent.threadId, limit: 100, sortDirection: "desc" }))
      if (!current()) throw new Error("SESSION_LOST")
      const turns = Array.isArray(page.data) ? page.data : []
      const last = turns.map(object).find(t => typeof t.id === "string" && t.status === "completed")
      if (!last) throw new Error("NO_PARENT")
      context = { lastTurnId: last.id, contextAt: typeof last.completedAt === "number" ? last.completedAt * 1000 : typeof metadata.updatedAt === "number" ? metadata.updatedAt * 1000 : Date.now() }
    }
    if (!current()) throw new Error("SESSION_LOST")
    await connection.beforeTurn?.()
    if (!current()) throw new Error("SESSION_LOST")
    const official = connection.execution?.mode === "official-same-home"
    const result = object(await client.request("thread/fork", { threadId: parent.threadId, ...(context.path ? { path: context.path } : {}), ...(connection.execution ? { model: connection.execution.model } : {}), ...("readOnlySource" in context ? { readOnlySource: context.readOnlySource } : { lastTurnId: context.lastTurnId }), ...(official ? { runtimeWorkspaceRoots: [] } : {}), ephemeral: true, excludeTurns: true, cwd: connection.execution?.cwd ?? parent.cwd, approvalPolicy: "never", sandbox: "read-only", developerInstructions: persona.developerInstructions }))
    const child = object(result.thread)
    if (generation !== this.generation) throw new Error("SESSION_LOST")
    if (typeof child.id !== "string" || child.id === parent.threadId || child.ephemeral !== true) throw new Error("CHAT_POLICY_UNENFORCEABLE")
    if (official && (result.approvalPolicy !== "never" || result.sandbox?.type !== "readOnly" || result.model !== connection.execution?.model)) throw Error("CHAT_POLICY_UNENFORCEABLE")
    if ("readOnlySource" in context) context = validateSourceSnapshot(result.sourceSnapshot, context)
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
    void this.close(code)
  }
  async prepareSend(): Promise<void> {
    const connection = this.connection, generation = this.generation
    if (!this.isSessionOpen() || !connection) throw Error("SESSION_LOST")
    try { await connection.beforeTurn?.() }
    catch (error) { if (this.connection === connection && this.generation === generation) await this.close(error instanceof Error ? error.message : "CHAT_EXECUTION_POLICY"); throw error }
    if (this.connection !== connection || this.generation !== generation) throw Error("SESSION_LOST")
  }
  async send(text: string, observation?: { state: string; checkedAt: number | null }): Promise<ChatResponse> {
    if (!this.connection || !this.child || !this.persona) throw new Error("SESSION_LOST")
    if (this.active) throw new Error("BUSY")
    const connection = this.connection, child = this.child, generation = this.generation
    let settle!: ActiveSend["settle"]
    const result = new Promise<ChatResponse>((resolve, reject) => {
      settle = value => value instanceof Error ? reject(value) : resolve(value)
    })
    const request: ActiveSend = { connection, child, generation, turnId: null, deniedRequests: 0, settle, collector: new SideChatItemCollector(),
      timer: setTimeout(() => this.failAndClose(request, "OUTCOME_UNKNOWN"), 180_000) }
    request.timer.unref(); this.active = request
    // Notifications may finish A before its RPC response. Every continuation still owns only A.
    const execution = connection.execution
    const policy = execution ? { ...(execution.noEnvironment ? { environments: [] } : {}),
      ...(execution.mode === "official-same-home" ? { approvalPolicy: "never", sandboxPolicy: { type: "readOnly" }, runtimeWorkspaceRoots: [], effort: "low" } : {}),
      ...(execution.instructions === "collaboration-mode" ? { collaborationMode: { mode: "default", settings: { model: execution.model, reasoning_effort: execution.mode ? "low" : null, developer_instructions: this.persona.developerInstructions } } } : {}) } : {}
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
    if (turn.status !== "completed") { this.finish(request, new Error("TURN_FAILED")); return }
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
  close(code = "SESSION_LOST"): Promise<void> {
    if (this.closing) { this.generation++; return this.closing }
    let resolve!: () => void, reject!: (error: unknown) => void
    const closing = this.closing = new Promise<void>((yes, no) => { resolve = yes; reject = no })
    const connection = this.connection, hadSession = this.child !== null
    try {
      if (this.active) this.finish(this.active, new Error(code))
      this.generation++
      for (const unsubscribe of this.cleanup.splice(0)) unsubscribe()
      this.connection = null; this.child = null; this.persona = null
      // Reentrant service disposal observes this same cleanup promise.
      if (connection) for (const listener of [...this.closedListeners]) listener({ error: new Error(code), hadSession })
      Promise.resolve().then(() => connection?.stop()).then(resolve, reject)
    } catch (error) {
      Promise.resolve().then(() => connection?.stop()).then(() => reject(error), reject)
    }
    return closing
  }
}
