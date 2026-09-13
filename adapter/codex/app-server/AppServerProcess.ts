import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { redactDiagnosticText } from "../privacy/Redaction.ts"
import { AppServerJsonlClient } from "./AppServerJsonlClient.ts"

export class AppServerProcess {
  readonly codexPath: string
  private readonly env?: NodeJS.ProcessEnv
  private child: ChildProcessWithoutNullStreams | null = null
  client: AppServerJsonlClient | null = null
  processState: "STOPPED" | "STARTING" | "RUNNING" | "EXITED" = "STOPPED"
  stderrSummary: string | null = null

  constructor(codexPath: string, env?: NodeJS.ProcessEnv) {
    this.codexPath = codexPath
    this.env = env
  }

  async start(): Promise<AppServerJsonlClient> {
    if (this.client) return this.client
    this.processState = "STARTING"
    const child = spawn(this.codexPath, ["app-server", "--listen", "stdio://"], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: this.env ?? process.env,
    })
    this.child = child
    const client = new AppServerJsonlClient({ readable: child.stdout, writable: child.stdin })
    this.client = client
    child.stderr.on("data", (chunk: Buffer) => {
      const next = `${this.stderrSummary ?? ""} ${redactDiagnosticText(chunk.toString("utf8"), 4_096) ?? ""}`.trim()
      this.stderrSummary = next.slice(-4_096) || null
    })
    child.once("spawn", () => { this.processState = "RUNNING" })
    child.once("error", (error) => {
      this.stderrSummary = redactDiagnosticText(error.message) ?? null
      this.processState = "EXITED"
      client.close(new Error("app-server process error"))
    })
    child.once("exit", () => {
      this.processState = "EXITED"
      client.close(new Error("app-server process exited"))
    })
    return client
  }

  async stop(timeoutMs = 2_000): Promise<void> {
    const child = this.child
    this.child = null
    this.client?.close()
    this.client = null
    if (!child || child.exitCode !== null) {
      this.processState = "STOPPED"
      return
    }
    child.kill("SIGTERM")
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL")
        resolve()
      }, timeoutMs)
      timer.unref()
      child.once("exit", () => { clearTimeout(timer); resolve() })
    })
    this.processState = "STOPPED"
  }
}
