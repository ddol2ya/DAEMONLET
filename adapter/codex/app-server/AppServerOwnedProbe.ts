import { spawnSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CodexRunRegistry } from "../CodexRunRegistry.ts"
import { mapAppServerNotification } from "./AppServerEventMapper.ts"
import { validateAppServerNotification } from "./AppServerEventValidator.ts"
import { AppServerProcess } from "./AppServerProcess.ts"
import type { ProtocolDomainEvent } from "../../../src/protocol/types.ts"

export type OwnedProbeResult = {
  status: "passed" | "failed"
  scenario: "completed" | "interrupted"
  codexPath: string
  trace: Array<{ method: string; decision: string; at: number }>
  finalSnapshot: ReturnType<CodexRunRegistry["getSnapshot"]>
  error?: string
  errorStage?: string
}

export async function runOwnedProbe(codexPath: string, packageVersion: string, timeoutMs = 120_000, interrupt = false, options: { onProtocolEvent?: (event: ProtocolDomainEvent) => void; model?: string } = {}): Promise<OwnedProbeResult> {
  const workspace = await mkdtemp(join(tmpdir(), "daemonlet-codex-probe-"))
  const trace: OwnedProbeResult["trace"] = []
  const process = new AppServerProcess(codexPath)
  const registry = new CodexRunRegistry()
  const disconnectObserver = options.onProtocolEvent ? registry.subscribe(options.onProtocolEvent) : () => {}
  let unsubscribe: (() => void) | undefined
  let completionTimer: ReturnType<typeof setTimeout> | undefined
  let stage = "startup"
  let startedTurnId: string | null = null
  let resolveStarted!: () => void
  const started = new Promise<void>((resolve) => { resolveStarted = resolve })
  try {
    await writeFile(join(workspace, "README.txt"), "This is a harmless Codex lifecycle adapter probe.\n", "utf8")
    spawnSync("git", ["init", "--quiet", workspace], { shell: false })
    const client = await process.start()
    stage = "initialize"
    await client.initialize({ name: "daemonlet_codex_pet_adapter", title: "Daemonlet for Codex Adapter", version: packageVersion })
    const completion = new Promise<void>((resolve, reject) => {
      completionTimer = setTimeout(() => reject(new Error("owned probe turn timed out")), timeoutMs)
      completionTimer.unref()
      unsubscribe = client.onNotification((method, params) => {
        const validation = validateAppServerNotification(method, params)
        if (!validation.ok) {
          trace.push({ method, decision: validation.code, at: Date.now() })
          return
        }
        if (!validation.value) return
        const event = mapAppServerNotification(validation.value)
        trace.push({ method, decision: event ? event.type : "ignored", at: validation.value.observedAt })
        if (event) {
          registry.apply(event)
          if (event.type === "run.started") {
            startedTurnId = event.turnId
            resolveStarted()
          }
        }
        if (method === "turn/completed") {
          if (completionTimer) clearTimeout(completionTimer)
          resolve()
        }
      })
    })
    stage = "thread-start"
    const threadResult = await client.request("thread/start", { cwd: workspace, approvalPolicy: "never", sandbox: "read-only", ephemeral: true, ...(options.model ? { model: options.model } : {}) }) as { thread?: { id?: string } }
    const threadId = threadResult?.thread?.id
    if (!threadId) throw new Error("thread/start returned no thread id")
    stage = "turn-start"
    const turnResult = await client.request("turn/start", {
      threadId,
      input: [{ type: "text", text: "Read README.txt, run pwd, then respond with a short confirmation. Do not modify files.", text_elements: [] }],
      approvalPolicy: "never",
    })
    if (interrupt) {
      stage = "turn-interrupt"
      // turn/start can acknowledge before the turn is interruptible. Wait for the live start edge.
      await Promise.race([started, completion])
      const turnId = startedTurnId ?? (turnResult as { turn?: { id?: string } })?.turn?.id
      if (!turnId) throw new Error("turn/start returned no turn id")
      await client.request("turn/interrupt", { threadId, turnId })
    }
    stage = "completion"
    await completion
    const hasLifecycle = interrupt
      ? trace.some((item) => item.decision === "run.started") && trace.some((item) => item.decision === "run.cancelled")
      : trace.some((item) => item.decision === "run.started") && trace.some((item) => item.decision === "task.started") && trace.some((item) => item.decision === "task.completed") && trace.some((item) => item.decision === "run.completed")
    stage = "lifecycle-validation"
    if (!hasLifecycle) throw new Error("owned probe did not observe the full lifecycle")
    return { status: "passed", scenario: interrupt ? "interrupted" : "completed", codexPath, trace, finalSnapshot: registry.getSnapshot() }
  } catch (error) {
    const detail = [error instanceof Error ? error.message : "owned probe failed", process.stderrSummary].filter(Boolean).join(": ").slice(0, 500)
    return { status: "failed", scenario: interrupt ? "interrupted" : "completed", codexPath, trace, finalSnapshot: registry.getSnapshot(), error: detail, errorStage: stage }
  } finally {
    if (completionTimer) clearTimeout(completionTimer)
    unsubscribe?.()
    disconnectObserver()
    await process.stop()
    await rm(workspace, { recursive: true, force: true })
  }
}
