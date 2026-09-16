import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { AppServerJsonlClient } from "../../adapter/codex/app-server/AppServerJsonlClient"
import type { ChatConnection, ChatExecutionProfile } from "../../electron/main/side-chat/SideChatBackend"

/** Candidate constraints audited against generated schema and upstream source.
 * This definition is not a production admission. The policy factory owns admission. */
export const FIXTURE_CONSTRAINTS = {
  web_search: "disabled", approval_policy: "never", sandbox_mode: "read-only",
  history: { persistence: "none" },
  features: { shell_tool: false, view_image: false, shell_snapshot: false, hooks: false, goals: false, apps: false, plugins: false },
  tools: { experimental_request_user_input: { enabled: false }, update_plan: { enabled: false } },
  agents: { enabled: false },
  otel: { log_user_prompt: false, exporter: "none" },
} as const

/** App-owned capability ceiling, loaded through Codex's documented custom catalog.
 * This pins model-side capabilities and removes mutable catalog mode instructions.
 * It does not override administrator requirements or change the provider/model. */
export const FIXTURE_MODEL_CATALOG = { models: [{
  slug: "gpt-5.6-luna", display_name: "gpt-5.6-luna", description: "Daemonlet text-only profile",
  supported_reasoning_levels: [{ effort: "low", description: "Low" }], default_reasoning_level: "low",
  shell_type: "disabled", visibility: "list", supported_in_api: true, priority: 1,
  support_verbosity: false, experimental_supported_tools: [], apply_patch_tool_type: null,
  base_instructions: "You are a text-only character companion. Follow the app's developer policy.",
  truncation_policy: { mode: "tokens", limit: 10000 }, context_window: 100000, max_context_window: 100000,
  auto_compact_token_limit: 80000, input_modalities: ["text"],
  include_skills_usage_instructions: false, include_plugin_usage_instructions: false, include_apps_usage_instructions: false,
}] } as const
export async function writeFixtureCatalog(root: string): Promise<string> {
  const path = join(root, "chat-models.json")
  await writeFile(path, JSON.stringify(FIXTURE_MODEL_CATALOG), { mode: 0o600 })
  return path
}

export type ChatLaunchOptions = { executable: string; root: string; execution?: Omit<ChatExecutionProfile, "cwd"> }
/** Lower-level process primitive. Only trusted Main code or explicit test DI calls it.
 * No config/env flag or renderer route selects a candidate instead of the policy gate. */
export async function launchFixtureParent(options: ChatLaunchOptions): Promise<ChatConnection> {
  const home = join(options.root, "home"), codex = join(options.root, "codex"), cwd = join(options.root, "project"), temp = join(options.root, "tmp")
  for (const path of [home, codex, cwd, temp, join(home, ".config"), join(home, ".local/share")]) await mkdir(path, { recursive: true, mode: 0o700 })
  const child = spawn(options.executable, ["app-server", "--listen", "stdio://"], { cwd,
    env: { PATH: process.platform === "win32" ? process.env.PATH : "/usr/bin:/bin:/usr/sbin:/sbin", ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } : {}),
      HOME: home, USERPROFILE: home, CODEX_HOME: codex, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"), TMPDIR: temp, TMP: temp, TEMP: temp },
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
  // Never forward model text or authentication diagnostics into the app log.
  child.stderr.resume()
  const client = new AppServerJsonlClient({ readable: child.stdout, writable: child.stdin })
  child.once("error", () => client.close(new Error("SESSION_LOST")))
  let ended = false
  child.once("close", () => { ended = true; client.close(new Error("SESSION_LOST")) })
  let stopping: Promise<void> | null = null
  return { ...(options.execution ? { execution: { ...options.execution, cwd } } : {}), client, stop: () => stopping ??= new Promise<void>(resolve => {
    client.close()
    if (ended || !child.pid || child.exitCode !== null || child.signalCode !== null) { resolve(); return }
    const timer = setTimeout(() => child.kill("SIGKILL"), 2000)
    child.once("close", () => { clearTimeout(timer); resolve() })
    child.kill("SIGTERM")
  }) }
}

/** Account-free official regression only. This module never enters a product build. */
export async function launchOfficialFixture(options: { executable: string; root: string; codexHome: string; osHome: string; disabledMcpServers: string[] }): Promise<ChatConnection> {
  const { OFFICIAL_CHAT_OVERRIDES } = await import("../../electron/main/side-chat/OfficialSameHomeLaunchProfile")
  const { startChatProcess } = await import("../../electron/main/side-chat/ChatProcess")
  const { SIDE_CHAT_MODEL } = await import("../../electron/main/side-chat/SideChatModelPolicy")
  const cwd = join(options.root, "work"), temp = join(options.root, "tmp")
  await mkdir(cwd, { recursive: true }); await mkdir(temp, { recursive: true })
  const overrides: Record<string, unknown> = { ...OFFICIAL_CHAT_OVERRIDES, model_provider: "fixture" }
  for (const name of options.disabledMcpServers) overrides["mcp_servers." + name + ".enabled"] = false
  const args = Object.entries(overrides).flatMap(([key, value]) => ["-c", key + "=" + JSON.stringify(value)])
  const child = startChatProcess(options.executable, [...args, "app-server", "--listen", "stdio://"], cwd, {
    HOME: options.osHome, USERPROFILE: options.osHome, CODEX_HOME: options.codexHome,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: temp, TMP: temp, TEMP: temp,
  })
  return { ...child, execution: { mode: "official-same-home" as const, cwd, model: SIDE_CHAT_MODEL.id, instructions: "collaboration-mode" as const, noEnvironment: true } }
}
