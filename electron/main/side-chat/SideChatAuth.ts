import { constants } from "node:fs"
import { lstat, open } from "node:fs/promises"
import { join } from "node:path"
import type { AppServerJsonlClient } from "../../../adapter/codex/app-server/AppServerJsonlClient"

/** Native usage metadata supplies a backend-bound workspace ID on 0.154.0.
 * ordinaryUsageAllowed is populated only after Codex matches both account and
 * user IDs to its active credentials. No tokens or keyring content leave Codex. */
export async function readOfficialAccountBinding(client: AppServerJsonlClient, home: string, store: string) {
  const account: any = await client.request("account/read", { refreshToken: false }).catch(() => { throw Error("CHAT_AUTH_UNAVAILABLE") })
  if (account.account?.type !== "chatgpt" || account.requiresOpenaiAuth !== true) throw Error(store === "file" ? "CHAT_AUTH_REQUIRED" : "CHAT_AUTH_UNAVAILABLE")
  if (typeof account.account.email !== "string" || !account.account.email) throw Error("CHAT_AUTH_IDENTITY_UNAVAILABLE")
  const usage: any = await client.request("account/rateLimits/read", { supportsLunaReserve: false, excludeResetCreditDetails: true }).catch(() => null)
  const id = usage?.accountId
  if (typeof id === "string" && id.length > 0 && id.length <= 256 && typeof usage.ordinaryUsageAllowed === "boolean") {
    if (store === "file" && await readChatAuthIdentity(home) !== id) throw Error("CHAT_ACCOUNT_CHANGED")
    return { email: account.account.email as string, accountId: id, usageAllowed: usage.ordinaryUsageAllowed as boolean, source: "protocol" as const }
  }
  if (store !== "file") throw Error("CHAT_AUTH_IDENTITY_UNAVAILABLE")
  return { email: account.account.email as string, accountId: await readChatAuthIdentity(home), usageAllowed: null, source: "file" as const }
}
/** Account binding only. Native Codex owns authentication and token refresh in
 * same-home mode; Main retains no tokens and never logs/copies this file. */
export async function readChatAuthIdentity(home: string): Promise<string> {
  let file: Awaited<ReturnType<typeof open>> | null = null
  try {
    const path = join(home, "auth.json"), named = await lstat(path)
    if (!named.isFile() || named.nlink !== 1 || named.size > 64 * 1024 || process.platform !== "win32" && (named.uid !== process.getuid?.() || (named.mode & 0o077) !== 0)) throw Error("CHAT_AUTH_REQUIRED")
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const before = await file.stat()
    if (before.dev !== named.dev || before.ino !== named.ino || before.size > 64 * 1024) throw Error("CHAT_AUTH_REQUIRED")
    const bytes = Buffer.alloc(before.size + 1), { bytesRead } = await file.read(bytes, 0, bytes.length, 0), after = await file.stat(), entry = await lstat(path)
    if (bytesRead !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || after.nlink !== 1 || entry.dev !== after.dev || entry.ino !== after.ino || !entry.isFile()) throw Error("CHAT_AUTH_REQUIRED")
    const data = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")), id = data.tokens?.account_id
    if (data.auth_mode !== "chatgpt" || typeof id !== "string" || !id || id.length > 256) throw Error("CHAT_AUTH_REQUIRED")
    return id
  } catch { throw Error("CHAT_AUTH_REQUIRED") }
  finally { await file?.close() }
}
