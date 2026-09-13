import { sanitizeHookReceipts } from "../../adapter/codex/hooks/HookEvents"
import type { PublicSetupStatus } from "../shared/codex-integration-contract"

export function createSetupDiagnostics(status: PublicSetupStatus): Record<string, unknown> {
  const discovery = status.discovery
  return {
    schemaVersion: 1, recordedAt: new Date(status.checkedAt).toISOString(),
    source: "user-reported",
    app: { version: status.app.version, platform: status.app.platform, packaged: status.app.packaged, running: true },
    onboarding: status.onboarding,
    configurationStatus: status.configurationStatus,
    paths: { codexHome: "<selected Codex Home>", hookFile: "<selected Codex Home>/hooks.json", executable: "<Pet.app>/Contents/MacOS/<Pet executable>", forwarder: "<Pet.app>/Contents/Resources/codex/hook-forwarder.mjs", dataDirectory: "<Adapter dataDir>", settings: "<app userData>/codex-integration.json" },
    host: { mode: status.host.mode, available: status.host.available, runAsNode: status.host.runAsNode, temporaryLocation: status.host.temporaryLocation },
    hostSelfTest: {
      source: status.hostSelfTest.source, status: status.hostSelfTest.status, checkedAt: status.hostSelfTest.checkedAt,
      budgetMs: status.hostSelfTest.budgetMs, coldStartMs: status.hostSelfTest.coldStartMs, repeatMs: status.hostSelfTest.repeatMs.slice(0, 10),
      receiverVerified: status.hostSelfTest.receiverVerified, sanitized: status.hostSelfTest.sanitized, cleanedUp: status.hostSelfTest.cleanedUp,
    },
    codex: discovery ? { version: discovery.executable.version, probeStatus: discovery.executable.probeStatus, contract: discovery.capability.contractId, contractSurface: discovery.capability.surface, support: discovery.capability.events, feature: discovery.feature, policy: discovery.policy, inlineOwnedConflict: discovery.inlineOwnedConflict } : null,
    inspectedScope: discovery?.inspectedScope ?? [], uninspectedScope: discovery?.uninspectedScope ?? [],
    adapter: { state: status.adapter.state, ownership: status.adapter.ownership, activeRunCount: status.adapter.activeRunCount, activeTaskCount: status.adapter.activeTaskCount },
    review: { status: status.hookReviewStatus, source: "user-reported", authoritativeTrustLookup: false },
    observation: {
      source: "user-reported", surface: status.live.surface, status: status.live.status, startedAt: status.live.startedAt,
      events: sanitizeHookReceipts(status.live.events), interrupt: status.live.interrupt, desktopStopAttempt: status.live.desktopStopAttempt,
      osSourceAttestation: false, sameRunCorrelation: false,
    },
    reception: { status: status.reception.status, lastReceivedAt: status.reception.lastReceivedAt, events: sanitizeHookReceipts(status.reception.events), source: "owned-adapter-receipts", osSourceAttestation: false },
    limitations: ["config.toml-is-read-only", "hook-review-is-user-reported", "event-receipts-do-not-attest-the-source-process", "Desktop-stop-requires-a-separate-user-action", "unsigned-candidate-requires-signed-host-revalidation"],
  }
}
