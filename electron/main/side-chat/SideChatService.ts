import { randomUUID } from "node:crypto"
import { SIDE_CHAT_LIMITS, utf8Bytes, validChatInput, type ChatRequest, type ChatSubmission, type ChatError, type SideChatSnapshot, type ChatResponse } from "../../shared/side-chat-contract"
import type { AppLanguage } from "../../shared/app-language"
import type { PersonaBinding } from "./PersonaResolver"
import type { ChatParent, SideChatBackend } from "./SideChatBackend"

const errors = new Set<ChatError>(["CHAT_DISABLED", "CHAT_POLICY_UNENFORCEABLE", "NO_PARENT", "BUSY", "STALE_REQUEST", "INVALID_REQUEST", "INPUT_LIMIT", "HISTORY_LIMIT", "RESPONSE_INVALID", "REFUSED", "STOPPED", "SESSION_LOST", "OUTCOME_UNKNOWN", "PACK_PERSONA", "REQUEST_LIMITED"])
export function chatError(error: unknown): ChatError { const code = error instanceof Error ? error.message as ChatError : "SESSION_LOST"; return errors.has(code) ? code : "SESSION_LOST" }

/** All transcripts, drafts and request IDs live only in this instance's memory. */
export class SideChatService {
  private state: SideChatSnapshot = { handle: randomUUID(), epoch: 1, enabled: false, mode: "hidden", language: "ko", character: { id: "gpichan", label: "지피쨩" }, parent: null, candidates: [], phase: "idle", applying: false, error: null, notice: null, messages: [], draft: "", draftRevision: 0, acceptedSubmission: null, task: { state: "unknown", checkedAt: null } }
  private persona: PersonaBinding | null = null
  private parent: ChatParent | null = null
  private backend: SideChatBackend | null = null
  private candidates = new Map<string, ChatParent>()
  private requests = new Set<string>()
  private listeners = new Set<() => void>()
  private deferred: (() => void) | null = null
  private cleanup: Promise<unknown> = Promise.resolve()
  constructor(private readonly createBackend: () => SideChatBackend) {}
  snapshot(): SideChatSnapshot { return structuredClone(this.state) }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish() { for (const listener of this.listeners) listener() }
  configure(enabled: boolean, language: AppLanguage) {
    if (this.state.language !== language) { this.state.language = language; this.resetConversation("language"); this.persona = null }
    if (this.state.enabled !== enabled) {
      this.state.enabled = enabled
      if (!enabled) { this.resetConversation(null); this.state.draft = ""; this.state.draftRevision++; this.state.mode = "hidden" }
    }
    this.publish()
  }
  /** Called at selection intent; replies are withheld until the renderer's ready result. */
  beginCharacterApply() { this.state.applying = true; this.publish() }
  characterFailed() { this.state.applying = false; const deferred = this.deferred; this.deferred = null; deferred?.(); this.publish() }
  applyPersona(binding: PersonaBinding) {
    const changed = this.persona && (this.persona.id !== binding.id || this.persona.revision !== binding.revision || this.persona.compiled.bindingHash !== binding.compiled.bindingHash)
    if (changed) this.resetConversation("character")
    this.persona = binding; this.state.character = { id: binding.id, label: binding.label }; this.state.applying = false
    const deferred = this.deferred; this.deferred = null; if (!changed) deferred?.()
    this.publish()
  }
  personaFailed() { this.resetConversation(null); this.persona = null; this.state.applying = false; this.state.error = "PACK_PERSONA"; this.state.phase = "error"; this.publish() }
  setCandidates(parents: ChatParent[], preferredThreadId?: string) {
    const previous = this.candidates
    this.candidates = new Map(parents.slice(0, 64).map(parent => [([...previous].find(([, p]) => p.threadId === parent.threadId)?.[0] ?? randomUUID()), { ...parent }]))
    this.state.candidates = [...this.candidates].map(([handle, p]) => ({ handle, title: p.title }))
    if (!this.parent && preferredThreadId) { const candidate = [...this.candidates].find(([, p]) => p.threadId === preferredThreadId); if (candidate) this.chooseParent(candidate[0]) }
    this.publish()
  }
  updateTask(state: string, checkedAt: number) { this.state.task = { state, checkedAt }; this.publish() }
  parentThreadId() { return this.parent?.threadId ?? null }
  chooseParent(handle: string) {
    const parent = this.candidates.get(handle)
    if (!parent) throw new Error("NO_PARENT")
    this.resetConversation("parent"); this.parent = { ...parent }; this.state.parent = { handle, title: parent.title, contextAt: null }; this.publish()
  }
  setMode(mode: SideChatSnapshot["mode"]) { if (mode !== "hidden" && !this.state.enabled) throw new Error("CHAT_DISABLED"); this.state.mode = mode; this.publish() }
  setDraft(text: string, revision = this.state.draftRevision + 1) {
    if (!this.state.enabled) throw new Error("CHAT_DISABLED")
    if (!validChatInput(text, true)) throw new Error("INPUT_LIMIT")
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("INVALID_REQUEST")
    // A delayed debounce cannot restore a submitted revision or replace a newer edit.
    if (revision <= this.state.draftRevision) return
    this.state.draft = text; this.state.draftRevision = revision; this.publish()
  }
  accept(request: ChatRequest) {
    if (request.handle !== this.state.handle || request.epoch !== this.state.epoch) throw new Error("STALE_REQUEST")
    if (this.requests.has(request.requestId)) throw new Error("STALE_REQUEST")
    // Bounded per-generation replay protection. Reset is always possible via Main.
    if (this.requests.size >= 20_000) throw new Error("REQUEST_LIMITED")
    this.requests.add(request.requestId)
  }
  reset() { this.resetConversation("reset"); this.publish() }
  private resetConversation(notice: SideChatSnapshot["notice"]) {
    this.state.acceptedSubmission = null
    this.state.epoch++; this.state.messages = []; this.state.phase = "idle"; this.state.error = null; this.state.notice = notice
    if (this.state.parent) this.state.parent.contextAt = null
    this.requests.clear(); this.deferred = null
    const backend = this.backend; this.backend = null
    if (backend) this.cleanup = Promise.allSettled([this.cleanup, backend.close()])
  }
  async send(text: string, submission: ChatSubmission = { requestId: randomUUID(), draftRevision: this.state.draftRevision + 1 }): Promise<void> {
    if (!this.state.enabled) throw new Error("CHAT_DISABLED")
    if (this.state.applying || ["preparing", "answering"].includes(this.state.phase)) throw new Error("BUSY")
    if (!validChatInput(text)) throw new Error("INPUT_LIMIT")
    if (!this.persona) throw new Error("PACK_PERSONA")
    if (!this.parent) throw new Error("NO_PARENT")
    if (["OUTCOME_UNKNOWN", "SESSION_LOST"].includes(this.state.error ?? "")) throw new Error(this.state.error!)
    const bytes = this.state.messages.reduce((sum, m) => sum + utf8Bytes(m.text) + utf8Bytes(m.preview), 0)
    if (this.state.messages.length + 2 > SIDE_CHAT_LIMITS.messages || bytes + utf8Bytes(text) + SIDE_CHAT_LIMITS.responseBytes + SIDE_CHAT_LIMITS.previewBytes > SIDE_CHAT_LIMITS.historyBytes) throw new Error("HISTORY_LIMIT")
    if (!Number.isSafeInteger(submission.draftRevision) || submission.draftRevision < 0) throw new Error("INVALID_REQUEST")
    if (submission.draftRevision < this.state.draftRevision || submission.draftRevision === this.state.draftRevision && this.state.draft !== text) throw new Error("STALE_REQUEST")
    // Save the submitted edit before opening. A known predispatch failure leaves it intact;
    // later edits remain authoritative, even if they happen to contain the same text.
    this.state.draft = text; this.state.draftRevision = submission.draftRevision
    const epoch = this.state.epoch, parent = this.parent, persona = this.persona
    this.state.phase = "preparing"; this.state.error = null; this.publish()
    let dispatched = false
    try {
      await this.cleanup
      if (epoch !== this.state.epoch) return
      if (!this.backend) {
        const backend = this.createBackend(); this.backend = backend
        const fork = await backend.open(parent, persona.compiled)
        if (epoch !== this.state.epoch || this.backend !== backend) { await backend.close(); return }
        if (this.state.parent) this.state.parent.contextAt = fork.contextAt
      }
      const backend = this.backend
      if (this.state.applying) throw new Error("BUSY")
      this.state.messages.push({ id: randomUUID(), role: "user", text, preview: "", at: Date.now() })
      this.state.acceptedSubmission = { ...submission }
      if (this.state.draftRevision === submission.draftRevision) this.state.draft = ""
      this.state.phase = "answering"; this.state.notice = null; this.publish(); dispatched = true
      const response = await backend.send(text, { ...this.state.task })
      const apply = () => {
        if (epoch !== this.state.epoch || this.backend !== backend) return
        this.appendResponse(response); this.state.phase = "idle"; this.publish()
      }
      if (epoch === this.state.epoch && this.state.applying) this.deferred = apply
      else apply()
    } catch (error) {
      if (epoch !== this.state.epoch) return
      const apply = () => {
        this.state.error = chatError(error); this.state.phase = this.state.error === "STOPPED" ? "stopped" : "error"
        this.publish()
      }
      if (this.state.applying) this.deferred = apply; else apply()
      if (!dispatched || ["SESSION_LOST", "OUTCOME_UNKNOWN", "CHAT_POLICY_UNENFORCEABLE"].includes(chatError(error))) {
        const backend = this.backend; this.backend = null; if (backend) this.cleanup = backend.close()
      }
    }
  }
  private appendResponse(response: ChatResponse) { this.state.messages.push({ id: randomUUID(), role: "assistant", text: response.text, preview: response.preview, at: Date.now() }) }
  async stop() {
    if (this.state.applying) throw new Error("BUSY")
    if (this.state.phase === "preparing") {
      this.state.epoch++; this.requests.clear(); this.state.phase = "stopped"; this.state.error = "STOPPED"
      if (!this.state.messages.length) { const backend = this.backend; this.backend = null; if (backend) this.cleanup = backend.close(); if (this.state.parent) this.state.parent.contextAt = null }
      this.publish(); return
    }
    await this.backend?.stop()
  }
  async dispose() { this.configure(false, this.state.language); this.candidates.clear(); this.parent = null; this.persona = null; this.state.parent = null; this.state.candidates = []; this.listeners.clear(); await this.cleanup }
}
