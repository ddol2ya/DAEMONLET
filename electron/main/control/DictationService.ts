import { StringDecoder } from "node:string_decoder"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import type { DictationSnapshot } from "../../shared/task-control-contract"

type NativeProcess = Pick<ChildProcessWithoutNullStreams, "stdout" | "stderr" | "stdin" | "once" | "kill">
const allowedErrors = new Set(["UNAVAILABLE", "PERMISSION_DENIED", "ON_DEVICE_UNAVAILABLE", "AUDIO_UNAVAILABLE", "RECOGNITION_FAILED"])
export class DictationService {
  private child: NativeProcess | null = null
  private state: DictationSnapshot = { sessionId: null, state: "idle", text: "", error: null }
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopTimer: ReturnType<typeof setTimeout> | null = null
  private listeners = new Set<(snapshot: DictationSnapshot) => void>()
  constructor(private readonly helperPath: string, private readonly launch: (path: string) => NativeProcess = path => spawn(path, ["--dictate"], { shell: false, stdio: ["pipe", "pipe", "pipe"] }), private readonly platform: NodeJS.Platform = process.platform) {}
  subscribe(listener: (snapshot: DictationSnapshot) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private emit(): void { for (const listener of this.listeners) listener({ ...this.state }) }
  snapshot(): DictationSnapshot { return { ...this.state } }
  start(sessionId: string): void {
    if (this.child) throw new Error("OPERATION_PENDING")
    if (this.platform !== "darwin") throw new Error("UNAVAILABLE")
    this.state = { sessionId, state: "starting", text: "", error: null }; this.emit()
    let child: NativeProcess
    try { child = this.launch(this.helperPath) } catch { this.state.state = "error"; this.state.error = "UNAVAILABLE"; this.emit(); return }
    this.child = child
    let buffer = "", final = false
    const decoder = new StringDecoder("utf8")
    const finish = (error: DictationSnapshot["error"] = null) => {
      if (this.child !== child) return
      if (this.timer) clearTimeout(this.timer); this.timer = null
      if (this.stopTimer) clearTimeout(this.stopTimer); this.stopTimer = null
      this.child = null; this.state.state = error ? "error" : "idle"; this.state.error = error; this.emit()
      child.stdin.end(); child.kill("SIGTERM")
    }
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.child !== child) return
      buffer += decoder.write(chunk)
      if (Buffer.byteLength(buffer) > 64 * 1024) { finish("RECOGNITION_FAILED"); return }
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n"), line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
        let value: any
        try { value = JSON.parse(line) } catch { finish("RECOGNITION_FAILED"); return }
        if (!value || typeof value !== "object") { finish("RECOGNITION_FAILED"); return }
        if (value.type === "listening" && this.state.state !== "stopping") this.state.state = "listening"
        else if (["partial", "final"].includes(value.type)) {
          if (typeof value.text !== "string" || value.text.length > 4000 || value.text.includes("\0")) { finish("RECOGNITION_FAILED"); return }
          // Ending audio can produce an empty result after a useful partial.
          // Keep the latest recognized text in this session for the editable draft.
          if (value.text.trim()) this.state.text = value.text
          if (value.type === "final") { final = true; finish(); return }
        } else if (value.type === "error") { finish(allowedErrors.has(value.code) ? value.code : "RECOGNITION_FAILED"); return }
        this.emit()
      }
    })
    // Native diagnostics can include recognized content; drain without logging or retaining it.
    child.stderr.on("data", () => {})
    child.stdin.on("error", () => finish("RECOGNITION_FAILED"))
    child.once("error", () => finish("UNAVAILABLE"))
    child.once("exit", () => finish(final || this.state.state === "stopping" ? null : "RECOGNITION_FAILED"))
    this.timer = setTimeout(() => finish(), 70_000); this.timer.unref()
  }
  stop(sessionId: string): void {
    if (this.state.sessionId !== sessionId || !this.child) return
    this.state.state = "stopping"; this.emit()
    this.child.stdin.write("stop\n")
    this.stopTimer = setTimeout(() => this.cancel(), 2500); this.stopTimer.unref()
  }
  cancel(): void {
    if (this.timer) clearTimeout(this.timer); this.timer = null
    if (this.stopTimer) clearTimeout(this.stopTimer); this.stopTimer = null
    const child = this.child; this.child = null
    if (child) { child.stdin.end("cancel\n"); child.kill("SIGTERM") }
    // Never replay a final transcript into a different task or a later recording.
    this.state = { sessionId: null, state: "idle", text: "", error: null }; this.emit()
  }
  dispose(): void { this.cancel(); this.listeners.clear() }
}
