import { constants } from "node:fs"
import { lstat, open } from "node:fs/promises"
import { join } from "node:path"
export type ChatAuthTokens = { accessToken: string; chatgptAccountId: string; chatgptPlanType?: string }
const claims = (jwt: string): Record<string, any> => {
  try { return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8")) } catch { throw Error("CHAT_AUTH_REQUIRED") }
}
/** Broker an existing Codex login through the official in-memory external-token
 * contract. Never copy auth.json, refresh OAuth tokens, log them or write the source. */
export async function readChatAuthTokens(home: string): Promise<ChatAuthTokens> {
  const path = join(home, "auth.json")
  let file: Awaited<ReturnType<typeof open>> | null = null
  try {
    const named = await lstat(path)
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.size > 64 * 1024 || process.platform !== "win32" && (named.uid !== process.getuid?.() || (named.mode & 0o077) !== 0)) throw Error("CHAT_AUTH_REQUIRED")
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const opened = await file.stat()
    if (opened.dev !== named.dev || opened.ino !== named.ino) throw Error("CHAT_AUTH_REQUIRED")
    const parsed = JSON.parse(await file.readFile("utf8")), token = parsed.tokens?.access_token
    if (parsed.auth_mode !== "chatgpt" || typeof token !== "string" || token.length > 32 * 1024) throw Error("CHAT_AUTH_REQUIRED")
    const payload = claims(token), auth = payload["https://api.openai.com/auth"] ?? {}
    // Expiration is not signature validation: the actual Codex/OpenAI auth path validates it.
    if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now() + 60_000) throw Error("CHAT_AUTH_REQUIRED")
    const accountId = parsed.tokens.account_id ?? auth.chatgpt_account_id
    if (typeof accountId !== "string" || !accountId || accountId.length > 256) throw Error("CHAT_AUTH_REQUIRED")
    return { accessToken: token, chatgptAccountId: accountId, ...(typeof auth.chatgpt_plan_type === "string" ? { chatgptPlanType: auth.chatgpt_plan_type } : {}) }
  } catch { throw Error("CHAT_AUTH_REQUIRED") }
  finally { await file?.close() }
}
