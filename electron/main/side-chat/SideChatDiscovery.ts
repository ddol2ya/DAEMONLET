import { lstat } from "node:fs/promises"
import { OFFICIAL_RUNTIME_REGISTRY } from "./OfficialRuntimeRegistry"
import { RUNTIME_VERIFICATION_TIMEOUT_MS } from "./OfficialRuntimeVerification"
import { codexExecutableCandidates, inspectOfficialCodexExecutable, resolveNativeCandidate } from "../../../adapter/codex/runtime/CodexExecutable.ts"
export { codexExecutableCandidates as sideChatCandidates, resolveNativeCandidate } from "../../../adapter/codex/runtime/CodexExecutable.ts"

export async function inspectSideChatRuntime(selected?: string | null, signal?: AbortSignal) {
  if (!OFFICIAL_RUNTIME_REGISTRY.some(item => item.platform === process.platform && item.arch === process.arch)) throw Error("CHAT_PLATFORM_UNVERIFIED")
  const deadline = AbortSignal.timeout(RUNTIME_VERIFICATION_TIMEOUT_MS)
  const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline
  let found = false
  const seen = new Set<string>()
  for (const candidate of codexExecutableCandidates(selected)) {
    bounded.throwIfAborted()
    try {
      const path = await resolveNativeCandidate(candidate)
      if (seen.has(path)) continue
      seen.add(path)
      await lstat(path); found = true
      return await inspectOfficialCodexExecutable(path, bounded)
    } catch { /* Continue bounded discovery; never execute an unverified file. */ }
  }
  bounded.throwIfAborted()
  throw Error(found ? "CHAT_RUNTIME_UNSUPPORTED" : "CHAT_RUNTIME_MISSING")
}
