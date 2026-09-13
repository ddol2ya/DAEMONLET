import { StringDecoder } from "node:string_decoder"
import { jsonParser, type Token } from "stream-json/core/parser.js"
import { filter } from "stream-json/core/filters/filter.js"
import { Assembler } from "stream-json/assembler.js"
import { isMany, none, type Many } from "stream-chain/defs.js"
import { isDesktopStatePath } from "./DesktopConversationState"

const envelope = new Set(["type", "requestId", "method", "version", "sourceClientId", "handledByClientId", "resultType", "error"])
const resultFields = new Set(["clientId", "supportsUntrustedAppInput", "ok", "interruptedTurnId"])
const paramsFields = new Set(["conversationId", "hostId", "clientId", "status", "following"])
const validKey = (value: string | number) => typeof value === "number" ? Number.isInteger(value) && value >= 0 && value < 4096 : value.length <= 4096 && !["__proto__", "constructor", "prototype"].includes(value)

/** Codex can include hundreds of MB of historical images in a snapshot. Tokenize
 * incrementally and discard bodies before assembly, preserving only the existing
 * follower protocol's status projection. Retained data has an independent bound.
 */
export class DesktopIpcProjection {
  private readonly decoder = new StringDecoder("utf8")
  private readonly parse = jsonParser({ packKeys: true, streamKeys: true, packStrings: false, streamStrings: true, packNumbers: false, streamNumbers: true })
  private readonly assembler = new Assembler<Record<string, any>>()
  private readonly project = filter({ filter: path => this.accept(path), maxDepth: 64, streamKeys: false })
  private readonly patchPaths = new Map<number, Array<string | number>>()
  private stringValue = ""
  private numberValue = ""
  private inKey = false
  private keyLength = 0
  private retained = 0
  private depth = 0
  private values = 0
  private accept(raw: Array<string | number | null>): boolean {
    if (raw.some(key => key === null || !validKey(key))) return false
    const path = raw as Array<string | number>
    if (path.length === 1 && envelope.has(String(path[0]))) return true
    if (path[0] === "targetClientIds") return path.length <= 2
    if (path[0] === "result") return path.length === 2 && resultFields.has(String(path[1]))
    if (path[0] !== "params") return false
    if (path.length === 2 && paramsFields.has(String(path[1]))) return true
    if (path[1] !== "change") return false
    if (path.length === 3 && ["type", "revision", "baseRevision"].includes(String(path[2]))) return true
    if (path[2] === "conversationState") return isDesktopStatePath(path.slice(3))
    if (path[2] !== "patches") return false
    if (path.length <= 4) return true
    if (path[4] === "op") return path.length === 5
    if (path[4] === "path") return path.length <= 6
    if (path[4] !== "value" || typeof path[3] !== "number") return false
    const index = path[3]
    if (path.length === 5) {
      const target = Array.isArray(this.assembler.current) && this.assembler.stack.at(-1) === "path" ? this.assembler.current : this.assembler.current?.path
      if (Array.isArray(target) && target.length <= 10 && target.every(key => (typeof key === "string" || typeof key === "number") && validKey(key))) this.patchPaths.set(index, target)
    }
    const target = this.patchPaths.get(index)
    return Boolean(target && isDesktopStatePath([...target, ...path.slice(5)]))
  }
  private consumeOutput(output: Token | Many<Token> | typeof none): void {
    if (output === none) return
    const tokens = isMany(output) ? output.values as Token[] : [output as Token]
    for (const token of tokens) {
      if (token.name === "startString") { this.stringValue = ""; continue }
      if (token.name === "stringChunk") { this.stringValue += token.value; this.retained += token.value.length; if (this.stringValue.length > 4096 || this.retained > 2 * 1024 * 1024) throw new Error("PROTOCOL_METADATA_LIMIT"); continue }
      if (token.name === "endString") { this.assembler.consume({name:"stringValue",value:this.stringValue}); this.stringValue = ""; continue }
      if (token.name === "startNumber") { this.numberValue = ""; continue }
      if (token.name === "numberChunk") { this.numberValue += token.value; if (this.numberValue.length > 64) throw new Error("PROTOCOL_METADATA_LIMIT"); continue }
      if (token.name === "endNumber") {
        if (!Number.isFinite(Number(this.numberValue))) throw new Error("PROTOCOL_UNSUPPORTED")
        this.assembler.consume({name:"numberValue",value:this.numberValue}); this.numberValue = ""; continue
      }
      this.retained += "value" in token && typeof token.value === "string" ? token.value.length : 8
      if (this.retained > 2 * 1024 * 1024) throw new Error("PROTOCOL_METADATA_LIMIT")
      this.assembler.consume(token)
    }
  }
  private consume(input: string | typeof none): void {
    const output = input === none ? this.parse(none) : this.parse(input)
    if (output === none) return
    for (const token of output.values) {
      if (token.name === "startKey") { this.inKey = true; this.keyLength = 0 }
      if (token.name === "stringChunk" && this.inKey) {
        this.keyLength += token.value.length
        if (this.keyLength > 4096) throw new Error("PROTOCOL_METADATA_LIMIT")
      }
      if (token.name === "endKey") this.inKey = false
      if (token.name === "startObject" || token.name === "startArray") { if (++this.depth > 64) throw new Error("PROTOCOL_METADATA_LIMIT") }
      if (token.name === "endObject" || token.name === "endArray") { if (--this.depth === 0) this.values++ }
      this.consumeOutput(this.project(token))
    }
  }
  write(bytes: Uint8Array): void {
    // Bound both the tokenizer's transient token array and key accumulator.
    for (let offset = 0; offset < bytes.length; offset += 16 * 1024) this.consume(this.decoder.write(bytes.subarray(offset, offset + 16 * 1024)))
  }
  finish(): Record<string, any> {
    this.consume(this.decoder.end()); this.consume(none); this.consumeOutput(this.project(none))
    const value = this.assembler.current
    if (this.values !== 1 || this.depth !== 0 || !this.assembler.done || !value || typeof value !== "object" || Array.isArray(value)) throw new Error("PROTOCOL_UNSUPPORTED")
    return value
  }
  get retainedCharacters(): number { return this.retained }
}
