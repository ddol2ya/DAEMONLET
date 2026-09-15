import type { ChatConnection } from "./SideChatBackend"

/** No user/pack/renderer override can bypass this gate. Add a launch implementation
 * only with captured first-request, pre-execution tool/startup isolation evidence
 * for the exact executable + policy profile. A schema alone is insufficient. */
export const SIDE_CHAT_SUPPORT = { policyVersion: 1, supportedRuntimes: [] as readonly string[], code: "CHAT_POLICY_UNENFORCEABLE" } as const
export async function connectVerifiedSideChat(): Promise<ChatConnection> {
  // 0.153.4 protocol probes are documented in docs/side-chat-validation.md.
  // No audited chat-only launch profile currently satisfies the execution boundary.
  // Refuse BEFORE launching an account-bearing process or reading parent history.
  throw new Error(SIDE_CHAT_SUPPORT.code)
}
