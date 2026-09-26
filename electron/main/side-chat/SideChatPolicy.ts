import { realpath } from "node:fs/promises"
import { createHash } from "node:crypto"
import { inspectSideChatRuntime } from "./SideChatDiscovery"
import { OFFICIAL_RUNTIME_REGISTRY } from "./OfficialRuntimeRegistry"
export { inspectSideChatRuntime } from "./SideChatDiscovery"
import type { ChatConnection } from "./SideChatBackend"
import { connectOfficialSameHome } from "./OfficialSameHomeConnection"
import { OFFICIAL_CHAT_OVERRIDES } from "./OfficialSameHomeLaunchProfile"
import { MINIMUM_CODEX_VERSION } from "./OfficialRuntimeVerification"

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")
export const SIDE_CHAT_SUPPORT = { policyVersion: 6, minimumVersion: MINIMUM_CODEX_VERSION, reviewedRuntimes: OFFICIAL_RUNTIME_REGISTRY, code: "CHAT_PROFILE_MISSING" } as const
export const CHAT_PROFILE_HASH = sha(JSON.stringify({ policy: "readonly-project-companion-v1", overrides: OFFICIAL_CHAT_OVERRIDES, environments: [], instructions: "collaboration-mode", parentContract: "official-same-home", readAccess: "user-selected-files" }))
export type SideChatConnectOptions = { codexHome: string; authHome?: string; executable?: string | null }

export async function inspectSideChatExecutable(selected?: string | null): Promise<string> { return (await inspectSideChatRuntime(selected)).executable }

/** Only this factory authenticates production connections. No setting, environment
 * switch, pack or renderer can admit an unverified executable/profile combination. */
export async function connectVerifiedSideChat(options?: SideChatConnectOptions): Promise<ChatConnection> {
  if (!options) throw Error("CHAT_PROFILE_MISSING")
  const { executable, runtime } = await inspectSideChatRuntime(options.executable)
  if (runtime.kind === "official") {
    if (options.authHome && await realpath(options.authHome) !== await realpath(options.codexHome)) throw Error("CHAT_AUTH_REQUIRED")
    return connectOfficialSameHome(executable, options.codexHome)
  }
  // Saved custom selections require an explicit official executable selection.
  throw Error("CHAT_RUNTIME_UNSUPPORTED")
}
