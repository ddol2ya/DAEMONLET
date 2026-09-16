import { mkdtemp, realpath, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import type { ChatConnection } from "./SideChatBackend"
import { launchOfficialSameHomeProcess } from "./OfficialSameHomeLaunchProfile"
import { assertOfficialConfiguration, inspectOfficialStartup } from "./SideChatPermissionPolicy"
import { readChatAuthIdentity } from "./SideChatAuth"

/** The caller has admitted the native hash. All auth stays in Codex's supported
 * same-home credential path. No account/login/start or logout is sent. */
export async function connectOfficialSameHome(executable: string, codexHome: string): Promise<ChatConnection> {
  const startup = await inspectOfficialStartup(codexHome)
  const root = await realpath(await mkdtemp(join(tmpdir(), "daemonlet-official-chat-")))
  let connection: ChatConnection | null = null, stage = "launch"
  try {
    connection = await launchOfficialSameHomeProcess({ executable, codexHome, osHome: homedir(), root, disabledMcpServers: startup.disabledMcpServers })
    stage = "initialize"
    await connection.client.initialize({ name: "daemonlet_side_chat", title: "Daemonlet read-only companion", version: "4" }, "side-chat")
    const client = connection.client
    const verify = async () => {
      await startup.assertUnchanged()
      const requirements = await client.request("configRequirements/read", {})
      const effective = await client.request("config/read", { includeLayers: true })
      assertOfficialConfiguration(requirements, effective)
    }
    stage = "configuration"; await verify()
    stage = "authentication"
    const account: any = await client.request("account/read", { refreshToken: false })
    if (account.account?.type !== "chatgpt" || account.requiresOpenaiAuth !== true || !account.account.email) throw Error("CHAT_AUTH_REQUIRED")
    const identity = account.account.email
    const accountId = await readChatAuthIdentity(codexHome)
    stage = "model-availability"
    let cursor: string | undefined, available = false
    for (let n = 0; n < 5; n++) {
      const models: any = await client.request("model/list", { includeHidden: false, ...(cursor ? { cursor } : {}) })
      if (models.data?.some((model: any) => model.model === "gpt-5.6-luna" && model.supportedReasoningEfforts?.some((l: any) => l.reasoningEffort === "low"))) { available = true; break }
      if (!models.nextCursor) break
      cursor = models.nextCursor
    }
    if (!available) throw Error("CHAT_MODEL_UNAVAILABLE")
    connection.beforeTurn = async () => {
      await verify()
      const next: any = await client.request("account/read", { refreshToken: false })
      if (next.account?.type !== "chatgpt" || next.account.email !== identity || await readChatAuthIdentity(codexHome) !== accountId) throw Error("CHAT_AUTH_REQUIRED")
    }
    const stop = connection.stop
    connection.stop = async () => { try { await stop() } finally { await rm(root, { recursive: true, force: true }) } }
    return connection
  } catch (error) {
    await connection?.stop(); await rm(root, { recursive: true, force: true })
    throw Object.assign(error instanceof Error && /^CHAT_/.test(error.message) ? error : Error("CHAT_EXECUTION_POLICY"), { stage })
  }
}
