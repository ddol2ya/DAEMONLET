import { randomUUID } from "node:crypto"
import type { CharacterSelection } from "../shared/character-pack-contract"
import type { CharacterLoadTicket } from "../shared/character-load"

type Transition = { ticket: CharacterLoadTicket; phase: "loading" | "ready" | "failed"; done: Promise<void>; finish: (error?: Error) => void }
/** One renderer document and one character transition own readiness at a time. */
export class CharacterTransitions {
  generation = 0
  current: Transition | null = null
  constructor(private readonly effects: {
    begin: (ticket: CharacterLoadTicket) => void
    failed: (ticket: CharacterLoadTicket) => void
    timeout: (ticket: CharacterLoadTicket) => void
  }) {}
  get busy() { return this.current?.phase === "loading" }
  matches(ticket: CharacterLoadTicket) {
    const own = this.current?.ticket
    return Boolean(own && own.requestId === ticket.requestId && own.rendererGeneration === ticket.rendererGeneration && own.id === ticket.id && own.revision === ticket.revision)
  }
  begin(selection: CharacterSelection): Transition {
    const previous = this.current
    if (previous && previous.phase !== "failed" && previous.ticket.id === selection.id && previous.ticket.revision === selection.revision) return previous
    if (previous) this.fail(previous.ticket, Error("PACK_CANCELLED"))
    const ticket = { id: selection.id, revision: selection.revision, requestId: randomUUID(), rendererGeneration: this.generation }
    let finish!: Transition["finish"]
    const done = new Promise<void>((resolve, reject) => { finish = error => { clearTimeout(timer); error ? reject(error) : resolve() } })
    // Implicit startup/catalog changes have no caller awaiting them.
    void done.catch(() => {})
    const timer = setTimeout(() => { if (this.matches(ticket) && this.busy) this.effects.timeout(ticket) }, 45_000)
    this.current = { ticket, phase: "loading", done, finish }
    this.effects.begin(ticket)
    return this.current
  }
  ready(ticket: CharacterLoadTicket) {
    if (!this.matches(ticket) || !this.busy) return false
    this.current!.phase = "ready"; this.current!.finish()
    return true
  }
  fail(ticket: CharacterLoadTicket, error = Error("PACK_LOAD")) {
    if (!this.matches(ticket) || !this.busy) return false
    this.current!.phase = "failed"; this.current!.finish(error); this.effects.failed(ticket)
    return true
  }
  retire() {
    if (this.current) this.fail(this.current.ticket, Error("PACK_CANCELLED"))
    this.current = null; this.generation++
  }
}
