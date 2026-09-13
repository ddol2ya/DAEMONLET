import { DesktopActivityObserver } from "../main/activity/DesktopActivityObserver"
import { CodexAdapterService } from "../../adapter/codex/CodexAdapterService"
import { createCodexAdapterConfig } from "../../adapter/codex/CodexAdapterConfig"
import type { SanitizedAdapterDiagnostics } from "../shared/ipc-contract"
import { sanitizeHookReceipts } from "../../adapter/codex/hooks/HookEvents"

export type AdapterWorkerMessage =
  | { type: "source-availability"; available: boolean }
  | { type: "ready"; protocolEndpoint: string; hookEndpoint: string }
  | { type: "diagnostics"; value: SanitizedAdapterDiagnostics }
  | { type: "warning"; code: string; message: string }
  | { type: "stopped"; reason: string }
  // Private utility → Main mapping, never part of diagnostics, Protocol, or renderer DTOs.
  | { type: "conversation-target"; value: import("../../adapter/codex/lifecycle/CodexLifecycleObserver").LocalConversationTarget }

export type AdapterWorkerCommand =
  | { type: "start"; mode: "HOOK_OBSERVER" }
  | { type: "stop" }
  | { type: "restart" }
  | { type: "get-diagnostics" }

const parentPort = process.parentPort
let service: CodexAdapterService | null = null
let activityObserver: DesktopActivityObserver | null = null
let sourceAvailable: boolean | undefined

const send = (message: AdapterWorkerMessage) => parentPort?.postMessage(message)

function diagnostics(): SanitizedAdapterDiagnostics {
  const value = service?.getDiagnostics()
  const config = service?.config ?? createCodexAdapterConfig({ mode: "HOOK_OBSERVER" })
  return {
    state: value?.status ?? "STOPPED",
    message: value?.warnings.at(-1) ?? null,
    restartCount: 0,
    adapterOwnership: service ? "OWNED_UTILITY" : "NONE",
    protocolEndpoint: `ws://${config.protocolHost}:${config.protocolPort}/events`,
    hookEndpoint: value?.hookIngress.endpoint ?? `http://${config.hookHost}:${config.hookPort}/hook`,
    activeRunCount: value?.activeRunCount ?? 0,
    activeTaskCount: value?.activeTaskCount ?? 0,
    provisionalRecoveredRunCount: value?.provisionalRecoveredRunCount ?? 0,
    protocolClientCount: value?.protocolClientCount ?? 0,
    externalProbeFailures: 0,
    lastExternalProbeAt: null,
    warnings: value?.warnings.slice(-20) ?? [],
    hookEvents: sanitizeHookReceipts(value?.hookIngress.events),
  }
}

async function start(): Promise<void> {
  if (service) return
  try {
    service = new CodexAdapterService(createCodexAdapterConfig({ mode: "HOOK_OBSERVER" }), {
      onConversationTarget: value => send({ type: "conversation-target", value }),
      onSourceAvailability: available => {
        if (available !== sourceAvailable) { sourceAvailable = available; send({ type: "source-availability", available }) }
      },
    })
    await service.start()
    activityObserver = new DesktopActivityObserver({ home: service.config.codexHome, onSnapshot: value => service?.observeLiveActivity(value) })
    activityObserver.start()
    send({
      type: "ready",
      protocolEndpoint: `ws://${service.config.protocolHost}:${service.config.protocolPort}/events`,
      hookEndpoint: service.getDiagnostics().hookIngress.endpoint,
    })
    send({ type: "diagnostics", value: diagnostics() })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await service?.stop().catch(() => undefined)
    service = null
    send({ type: "warning", code: /EADDRINUSE/.test(message) ? "PORT_IN_USE" : "START_FAILED", message })
    send({ type: "stopped", reason: message })
  }
}

async function stop(reason = "requested"): Promise<void> {
  await activityObserver?.stop(); activityObserver = null; sourceAvailable = undefined
  const active = service
  service = null
  if (active) await active.stop()
  send({ type: "stopped", reason })
}

parentPort?.on("message", (event: { data: AdapterWorkerCommand }) => {
  const command = event.data
  if (!command || typeof command !== "object") return
  if (command.type === "start") void start()
  if (command.type === "stop") void stop().then(() => process.exit(0))
  if (command.type === "restart") void stop("restart").then(start)
  if (command.type === "get-diagnostics") send({ type: "diagnostics", value: diagnostics() })
})

process.once("SIGTERM", () => { void stop("sigterm").finally(() => process.exit(0)) })
