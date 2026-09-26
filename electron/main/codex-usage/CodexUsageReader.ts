import { mkdtemp, rm, lstat } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { AppServerRpcError } from "../../../adapter/codex/app-server/AppServerJsonlClient"
import { inspectSideChatRuntime, resolveNativeCandidate } from "../side-chat/SideChatDiscovery"
import { launchOfficialSameHomeProcess } from "../side-chat/OfficialSameHomeLaunchProfile"
import { assertOfficialConfiguration, inspectOfficialStartup } from "../side-chat/SideChatPermissionPolicy"
import { normalizeCodexUsage, record, type NormalizedUsage } from "./normalizeCodexUsage"
import type { CodexUsageReason } from "../../shared/codex-usage-contract"
import { RUNTIME_VERIFICATION_TIMEOUT_MS } from "../side-chat/OfficialRuntimeVerification"
export type UsageProvider = { executablePath: string | null; codexHome: string | null }
export type UsageRead = { value: NormalizedUsage; scope: string | null } | { reason: CodexUsageReason }
export const USAGE_RPC_TIMEOUT_MS = 10_000, USAGE_DEADLINE_MS = 25_000
export type UsageReader = (provider: UsageProvider, signal: AbortSignal) => Promise<UsageRead>
const fingerprint = async (path: string) => { const s = await lstat(path); return [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs, s.mode, s.uid].join(":") }
/** Main-only admission cache. Re-resolve the selected path and check native file
 * identity on every read; changed files must pass official byte verification. */
export function createCodexUsageReader(): UsageReader {
  let cached: { selected: string; executable: string; fingerprint: string } | null = null
  return async (provider, externalSignal) => {
    const controller = new AbortController(), signal = controller.signal
    let connection: Awaited<ReturnType<typeof launchOfficialSameHomeProcess>> | null = null
    let root: string | null = null, off: (() => void) | undefined
    const abort = () => { controller.abort(); void connection?.stop() }
    externalSignal.addEventListener("abort", abort, { once: true })
    if (externalSignal.aborted) abort()
    // A new npm version may need its official archive checked once. Metadata
    // RPCs retain their existing deadline after runtime admission completes.
    let timer = setTimeout(abort, RUNTIME_VERIFICATION_TIMEOUT_MS)
    const check = () => signal.throwIfAborted()
    try {
      check()
      if (!provider.codexHome || !provider.executablePath) return { reason: "cli-missing" }
      const selected = await resolveNativeCandidate(provider.executablePath); check()
      const before = await fingerprint(selected); check()
      if (!cached || cached.selected !== selected || cached.fingerprint !== before) {
        const checked = await inspectSideChatRuntime(provider.executablePath, signal); check()
        if (await fingerprint(checked.executable) !== before) throw Error("CHAT_RUNTIME_UNSUPPORTED")
        cached = { selected, executable: checked.executable, fingerprint: before }
      }
      clearTimeout(timer); timer = setTimeout(abort, USAGE_DEADLINE_MS)
      const startup = await inspectOfficialStartup(provider.codexHome); check()
      root = await mkdtemp(join(tmpdir(), "daemonlet-usage-")); check()
      connection = await launchOfficialSameHomeProcess({ executable: cached.executable, codexHome: provider.codexHome, osHome: homedir(), root, disabledMcpServers: startup.disabledMcpServers }); check()
      const client = connection.client
      off = client.onServerRequest(request => { void client.rejectServerRequest(request.id).catch(() => {}) })
      await client.initialize({ name: "daemonlet_usage", title: "Daemonlet account usage", version: "1" }, "side-chat", USAGE_RPC_TIMEOUT_MS); check()
      // Only these metadata methods are reachable. No model, thread or turn RPC.
      const request = (method: "configRequirements/read" | "config/read" | "account/read" | "account/rateLimits/read", params: unknown) => { check(); return client.request(method, params, USAGE_RPC_TIMEOUT_MS) }
      await startup.assertUnchanged(); check()
      assertOfficialConfiguration(await request("configRequirements/read", {}), await request("config/read", { includeLayers: true }))
      const accountResponse = record(await request("account/read", { refreshToken: false }))
      if (!accountResponse || !Object.hasOwn(accountResponse, "account")) return { reason: "invalid-response" }
      if (accountResponse.account === null) return { reason: "not-signed-in" }
      const account = record(accountResponse.account)
      if (account?.type === "apiKey") return { reason: "api-key-account" }
      if (account?.type !== "chatgpt") return { reason: "unsupported-account" }
      // Require this metadata contract; incompatible newer versions fail closed.
      // Never retry with weaker options or initiate a model request.
      const raw = await request("account/rateLimits/read", { supportsLunaReserve: false, excludeResetCreditDetails: true }); check()
      const value = normalizeCodexUsage(raw)
      if (!value) return { reason: "invalid-response" }
      const id = record(raw)?.accountId, user = account.email
      const scope = typeof id === "string" && id.length > 0 && id.length <= 256 && typeof user === "string" && user.length > 0 && user.length <= 512
        ? createHash("sha256").update(JSON.stringify([id, user])).digest("hex") : null
      return { value, scope }
    } catch (error) {
      const message = error instanceof Error ? error.message : ""
      return { reason: error instanceof AppServerRpcError && [-32601, -32602].includes(error.code ?? 0) ? "cli-unsupported"
        : /CHAT_RUNTIME_MISSING|ENOENT/.test(message) ? "cli-missing"
        : /CHAT_RUNTIME_UNSUPPORTED|CHAT_PLATFORM_UNVERIFIED|CHAT_EXECUTION_POLICY|CHAT_MANAGED_POLICY/.test(message) ? "cli-unsupported" : "query-failed" }
    } finally {
      clearTimeout(timer); externalSignal.removeEventListener("abort", abort); off?.()
      try { await connection?.stop() } finally { if (root) await rm(root, { recursive: true, force: true }) }
    }
  }
}
