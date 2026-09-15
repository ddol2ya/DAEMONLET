import { constants, createReadStream } from "node:fs"
import { access, lstat, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { basename, dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { stringify } from "smol-toml"
import type { ChatConnection } from "./SideChatBackend"
import { CHAT_LAUNCH_CONSTRAINTS, CHAT_MODEL_CATALOG, launchIsolatedChatProcess, writeChatModelCatalog } from "./SideChatLaunchProfile"
import { resolveChatParentSource } from "./SideChatSource"
import { PAGINATED_CHAT_RUNTIME } from "./SideChatRuntime"
import { readChatAuthTokens } from "./SideChatAuth"

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")
export const SIDE_CHAT_SUPPORT = { policyVersion: 3, supportedRuntimes: [{ version: "0.154.0", platform: "darwin", arch: "arm64", executableSha256: "4f85982624b3898c8991cb80c0981b2aa71070e3537046c9a95950318a95afcc", model: "gpt-5.6-luna", parentContract: "legacy-no-dynamic-tools", kind: "official" }, PAGINATED_CHAT_RUNTIME], code: "CHAT_PROFILE_MISSING" } as const
export const CHAT_PROFILE_HASH = sha(JSON.stringify({ constraints: CHAT_LAUNCH_CONSTRAINTS, catalog: CHAT_MODEL_CATALOG, environments: [], instructions: "collaboration-mode", parentContracts: ["legacy-no-dynamic-tools", "read-only-source-v1"] }))
export type SideChatConnectOptions = { codexHome: string; authHome?: string; executable?: string | null }

export async function inspectSideChatRuntime(selected?: string | null) {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw Error("CHAT_RUNTIME_UNSUPPORTED")
  const candidates = selected ? [selected] : ["/opt/homebrew/bin/codex", "/usr/local/bin/codex"]
  let found = false
  for (const candidate of candidates) {
    try {
      let path = await realpath(candidate)
      // Resolve an npm shim without executing it; only the pinned native bytes are admitted.
      if (basename(path) === "codex.js") path = await realpath(join(dirname(dirname(path)), "node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex"))
      const stat = await lstat(path); found = true
      if (!stat.isFile() || stat.size > (selected ? Math.max(350 * 1024 * 1024, PAGINATED_CHAT_RUNTIME.executableBytes) : 350 * 1024 * 1024) || ![0, process.getuid?.()].includes(stat.uid) || (stat.mode & 0o022)) continue
      await access(path, constants.X_OK)
      const hash = createHash("sha256")
      for await (const chunk of createReadStream(path)) hash.update(chunk)
      const digest = hash.digest("hex")
      const runtime = SIDE_CHAT_SUPPORT.supportedRuntimes.find(runtime => runtime.executableSha256 === digest && (runtime.kind === "official" || Boolean(selected)))
      if (runtime) return { executable: path, runtime }
    } catch { /* Try only the next fixed installation path. */ }
  }
  throw Error(found ? "CHAT_RUNTIME_UNSUPPORTED" : "CHAT_RUNTIME_MISSING")
}

export async function inspectSideChatExecutable(selected?: string | null): Promise<string> { return (await inspectSideChatRuntime(selected)).executable }

function constraintMismatches(actual: any, expected: any, prefix = ""): string[] {
  return Object.entries(expected).flatMap(([key, value]) => value !== null && typeof value === "object" && !Array.isArray(value)
    ? constraintMismatches(actual?.[key], value, prefix + key + ".") : actual?.[key] === value ? [] : [prefix + key])
}
export function assertChatConfiguration(requirements: any, effective: any, configPath: string, catalog: string | null): void {
  if (requirements.requirements !== null) throw Error("CHAT_MANAGED_POLICY")
  const layers = (effective.layers ?? []).filter((layer: any) => !layer.disabledReason)
  const owned = layers.find((layer: any) => layer.name?.type === "user" && layer.name.file === configPath)
  // ToolsV2 omits these two gates; verify their sole raw owned layer instead.
  const mismatches = constraintMismatches({ ...effective.config, tools: owned?.config?.tools }, CHAT_LAUNCH_CONSTRAINTS)
  if (!owned || layers.some((layer: any) => layer !== owned && Object.keys(layer.config ?? {}).length)) mismatches.push("additional-config-layer")
  if (catalog ? effective.config.model_catalog_json !== catalog : effective.config.model_catalog_json != null) mismatches.push("model_catalog_json")
  if (effective.config.model !== "gpt-5.6-luna" || (effective.config.model_provider ?? "openai") !== "openai") mismatches.push("model/provider")
  if (Object.keys(effective.config.model_providers ?? {}).length || Object.keys(effective.config.mcp_servers ?? {}).length) mismatches.push("providers/mcp")
  if (mismatches.length) throw Object.assign(Error("CHAT_EXECUTION_POLICY"), { mismatches })
}

/** Only this factory authenticates production connections. No setting, environment
 * switch, pack or renderer can admit an unverified executable/profile combination. */
export async function connectVerifiedSideChat(options?: SideChatConnectOptions): Promise<ChatConnection> {
  if (!options) throw Error("CHAT_PROFILE_MISSING")
  const { executable, runtime } = await inspectSideChatRuntime(options.executable)
  const root = await realpath(await mkdtemp(join(tmpdir(), "daemonlet-side-chat-")))
  let connection: ChatConnection | null = null, stage = "launch"
  try {
    await mkdir(join(root, "codex"), { mode: 0o700 })
    const catalog = await writeChatModelCatalog(root)
    const configPath = join(root, "codex/config.toml")
    const writeConfig = (pinned: boolean) => writeFile(configPath, stringify({ ...CHAT_LAUNCH_CONSTRAINTS, model: "gpt-5.6-luna", model_provider: "openai", ...(pinned ? { model_catalog_json: catalog } : {}), cli_auth_credentials_store: "ephemeral", mcp_servers: {} }), { mode: 0o600 })
    const verify = async (client: ChatConnection["client"], pinned: boolean) => {
      stage = "configuration"
      const requirements: any = await client.request("configRequirements/read", {})
      const effective: any = await client.request("config/read", { includeLayers: true })
      assertChatConfiguration(requirements, effective, configPath, pinned ? catalog : null)
    }
    let tokens = await readChatAuthTokens(options.authHome ?? options.codexHome)
    const start = async (pinned: boolean) => {
      await writeConfig(pinned)
      connection = await launchIsolatedChatProcess({ executable, root, execution: { model: "gpt-5.6-luna", noEnvironment: true, instructions: "collaboration-mode" } })
      stage = "initialize"
      await connection.client.initialize({ name: "daemonlet_side_chat", title: "Daemonlet side chat", version: "2" }, "side-chat")
      await verify(connection.client, pinned)
      stage = "authentication"
      await connection.client.request("account/login/start", { type: "chatgptAuthTokens", ...tokens })
      const account: any = await connection.client.request("account/read", { refreshToken: false })
      if (account.account?.type !== "chatgpt" || account.requiresOpenaiAuth !== true) throw Error("CHAT_AUTH_REQUIRED")
      await verify(connection.client, pinned)
      return connection
    }
    // Read the authenticated official catalog before pinning capabilities. A
    // custom catalog alone must never claim that a retired model is available.
    const discovery = await start(false)
    stage = "model-availability"
    const models: any = await discovery.client.request("model/list", { includeHidden: false })
    if (!models.data?.some((model: any) => model.model === "gpt-5.6-luna" && model.supportedReasoningEfforts?.some((level: any) => level.reasoningEffort === "low"))) throw Error("CHAT_MODEL_UNAVAILABLE")
    await discovery.stop()
    connection = await start(true)
    connection.parentContext = parent => resolveChatParentSource(options.codexHome, parent, runtime.parentContract === "read-only-source-v1" ? "read-only-source-v1" : "legacy")
    connection.refreshAuth = async () => {
      const next = await readChatAuthTokens(options.authHome ?? options.codexHome)
      if (next.chatgptAccountId !== tokens.chatgptAccountId || next.accessToken === tokens.accessToken) throw Error("CHAT_AUTH_REQUIRED")
      tokens = next; return next
    }
    const stop = connection.stop
    connection.stop = async () => { try { await stop() } finally { await rm(root, { recursive: true, force: true }) } }
    return connection
  } catch (error) {
    await connection?.stop(); await rm(root, { recursive: true, force: true })
    if (error instanceof Error && /^CHAT_/.test(error.message)) throw Object.assign(error, { stage })
    throw Object.assign(Error("CHAT_EXECUTION_POLICY"), { stage })
  }
}
