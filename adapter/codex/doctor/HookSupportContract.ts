import { allEventSupport, type EventSupport } from "../hooks/HookInstallPlan.ts"

export type HookSupportContract = {
  id: string
  version: string
  artifactSha256: string
  surface: "cli" | "desktop" | "synthetic"
  source: "installed-artifact-and-fixtures" | "official-artifact-and-embedded-schemas" | "test-fixture"
  events: EventSupport
  featureKey: "hooks" | "codex_hooks"
  eventTimeoutSeconds: number
}

// An exact artifact match, not a semver >= comparison or an App Server schema.
// The wire fixtures and their original evidence are linked in PACKAGED_HOOK_SETUP.
// Legacy offline contracts. Official npm CLI >=0.154.0 additionally uses shared
// official-byte verification and the installed binary's embedded Hook schemas.
// Desktop delivery remains a separate observation surface.
export const VERIFIED_HOOK_CONTRACTS: readonly HookSupportContract[] = [{
  id: "codex-cli-0.147.0-darwin-arm64",
  version: "codex-cli 0.147.0",
  artifactSha256: "19c4f144c5226a9f17c58e6f0fa854843b0f77a6eb420f40e2745a12f10f5d37",
  surface: "cli", source: "installed-artifact-and-fixtures", events: allEventSupport("supported"),
  featureKey: "hooks", eventTimeoutSeconds: 2,
}, {
  id: "codex-cli-0.153.4-darwin-arm64",
  version: "codex-cli 0.153.4",
  artifactSha256: "b973d440acac501fd2594a43e7ca9ce41e0a65b9dfb28d0d7a7837c99e1261e3",
  surface: "cli", source: "installed-artifact-and-fixtures",
  // Each event is backed by this artifact's embedded command-input schema and
  // contract-v0.153.4.json fixtures; this does not establish Desktop delivery.
  events: {
    SessionStart: "supported", SessionEnd: "supported", UserPromptSubmit: "supported",
    PreToolUse: "supported", PostToolUse: "supported",
    SubagentStart: "supported", SubagentStop: "supported", Stop: "supported", Interrupt: "supported",
  },
  featureKey: "hooks", eventTimeoutSeconds: 2,
}, {
  id: "codex-cli-0.151.0-win32-x64", version: "codex-cli 0.151.0",
  artifactSha256: "cf68265897197ac5f3bff6a10c168eec159842b353129726da5e3ed6b91ef0f4",
  surface: "cli", source: "installed-artifact-and-fixtures",
  // All nine embedded input schemas match the reviewed macOS wire format.
  // Actual delivery/trust is separate from this parser compatibility evidence.
  events: allEventSupport("supported"), featureKey: "hooks", eventTimeoutSeconds: 3,
}]

export function hookContractFor(artifactSha256: string | null, version: string | null, contracts: readonly HookSupportContract[] = VERIFIED_HOOK_CONTRACTS): HookSupportContract | null {
  return contracts.find((item) => item.artifactSha256 === artifactSha256 && item.version === version) ?? null
}
