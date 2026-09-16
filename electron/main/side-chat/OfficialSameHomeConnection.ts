import { mkdtemp, realpath, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import type { ChatConnection } from "./SideChatBackend"
import { launchOfficialSameHomeProcess } from "./OfficialSameHomeLaunchProfile"
import { assertOfficialConfiguration, inspectOfficialStartup } from "./SideChatPermissionPolicy"
import { readOfficialAccountBinding } from "./SideChatAuth"
import { isSideChatModelAvailable } from "./SideChatModelPolicy"
import { inspectSideChatRuntime } from "./SideChatDiscovery"

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
    let credentialStore = "file"
    const verify = async () => {
      await startup.assertUnchanged()
      const requirements = await client.request("configRequirements/read", {})
      const effective: any = await client.request("config/read", { includeLayers: true })
      assertOfficialConfiguration(requirements, effective)
      credentialStore = effective.config.cli_auth_credentials_store ?? "file"
    }
    stage = "configuration"; await verify()
    stage = "authentication"
    const identity = await readOfficialAccountBinding(client, codexHome, credentialStore)
    connection.authentication = { storage: credentialStore, binding: identity.source }
    if (identity.usageAllowed === false) throw Error("USAGE_LIMIT")
    stage = "model-availability"
    const verifyModel = async () => {
      let cursor: string | undefined
      const seen = new Set<string>()
      for (let n = 0; n < 5; n++) {
        const models: any = await client.request("model/list", { includeHidden: false, ...(cursor ? { cursor } : {}) })
        if (isSideChatModelAvailable(models.data)) return
        if (typeof models.nextCursor !== "string" || seen.has(models.nextCursor)) break
        cursor = models.nextCursor; seen.add(cursor!)
      }
      throw Error("CHAT_MODEL_UNAVAILABLE")
    }
    await verifyModel()
    connection.beforeTurn = async () => {
      await verify()
      // A long-lived Codex process caches auth. For keyring/auto, start a fresh
      // restricted metadata reader to observe external switches without dumping
      // protected credentials, refreshing tokens on demand, or controlling a parent.
      let probe: ChatConnection | null = null
      let probeRoot: string | null = null
      try {
        if (credentialStore !== "file") {
          const checked = await inspectSideChatRuntime(executable)
          probeRoot = await mkdtemp(join(root, "account-check-"))
          probe = await launchOfficialSameHomeProcess({ executable: checked.executable, codexHome, osHome: homedir(), root: probeRoot, disabledMcpServers: startup.disabledMcpServers })
          await probe.client.initialize({ name: "daemonlet_account_check", title: "Daemonlet account check", version: "1" }, "side-chat")
          assertOfficialConfiguration(await probe.client.request("configRequirements/read", {}), await probe.client.request("config/read", { includeLayers: true }))
        }
        const next = await readOfficialAccountBinding(probe?.client ?? client, codexHome, credentialStore)
        if (next.email !== identity.email || next.accountId !== identity.accountId) throw Error("CHAT_ACCOUNT_CHANGED")
        if (next.usageAllowed === false) throw Error("USAGE_LIMIT")
      } finally { await probe?.stop(); if (probeRoot) await rm(probeRoot, { recursive: true, force: true }) }
      await verifyModel()
    }
    const stop = connection.stop
    connection.stop = async () => { try { await stop() } finally { await rm(root, { recursive: true, force: true }) } }
    return connection
  } catch (error) {
    await connection?.stop(); await rm(root, { recursive: true, force: true })
    throw Object.assign(error instanceof Error && /^CHAT_/.test(error.message) ? error : Error("CHAT_EXECUTION_POLICY"), { stage })
  }
}
