import { mkdir, realpath } from "node:fs/promises"
import { join } from "node:path"
import { startChatProcess } from "./ChatProcess"
import { officialRuntimeEnvironment } from "./OfficialPlatform"
import { SIDE_CHAT_MODEL } from "./SideChatModelPolicy"
import type { ChatConnection } from "./SideChatBackend"

/** Pinned official 0.154.0 controls, applied before initialize. No user config
 * writes, external auth-token injection, custom catalog, or alternate home. */
export const OFFICIAL_CHAT_OVERRIDES: Record<string, unknown> = {
  model: SIDE_CHAT_MODEL.id, model_provider: "openai", model_reasoning_effort: SIDE_CHAT_MODEL.effort,
  approval_policy: "never", sandbox_mode: "read-only", default_permissions: ":read-only",
  web_search: "disabled", notify: [], "history.persistence": "none",
  "features.shell_tool": false, "features.shell_snapshot": false,
  "features.hooks": false, "features.goals": false,
  "features.apps": false, "features.plugins": false, "features.enable_mcp_apps": false,
  "features.code_mode": false, "features.code_mode_host": false, "features.code_mode_prewarm": false,
  "features.multi_agent_v2": false, "agents.enabled": false,
  "features.multi_agent": false, "features.js_repl": false,
  "features.computer_use": false, "features.remote_control": false,
  "features.memories": false, "features.external_agent_memory_import": false,
  "features.chronicle": false, "features.view_image": false,
  "features.image_generation": false, "features.request_permissions_tool": false,
  "features.skill_mcp_dependency_install": false,
  "tools.experimental_request_user_input.enabled": false, "tools.update_plan.enabled": false,
  "memories.generate_memories": false, "memories.use_memories": false,
  "memories.dedicated_tools": false, "orchestrator.mcp.enabled": false,
  "orchestrator.skills.enabled": false, project_doc_max_bytes: 0,
  "otel.log_user_prompt": false, "otel.exporter": "none",
}

export type OfficialLaunchOptions = {
  executable: string; codexHome: string; osHome: string; root: string
  /** Trusted Main preflight additions, never renderer/model/pack arguments. */
  disabledMcpServers: string[]
}
export async function launchOfficialSameHomeProcess(options: OfficialLaunchOptions): Promise<ChatConnection> {
  const cwd = join(options.root, "work"), temp = join(options.root, "tmp")
  await mkdir(cwd, { recursive: true, mode: 0o700 }); await mkdir(temp, { recursive: true, mode: 0o700 })
  const codexHome = await realpath(options.codexHome), osHome = await realpath(options.osHome)
  const overrides: Record<string, unknown> = { ...OFFICIAL_CHAT_OVERRIDES }
  for (const name of options.disabledMcpServers) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(name)) throw Error("CHAT_EXECUTION_POLICY")
    overrides[`mcp_servers.${name}.enabled`] = false
  }
  const args = Object.entries(overrides).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`])
  const process = startChatProcess(options.executable, [...args, "app-server", "--listen", "stdio://"], cwd, officialRuntimeEnvironment(osHome, codexHome, temp))
  return { ...process, execution: { mode: "official-same-home", cwd, model: SIDE_CHAT_MODEL.id, instructions: "collaboration-mode", noEnvironment: true } }
}
