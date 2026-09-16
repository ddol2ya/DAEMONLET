import { createHash } from "node:crypto"
import { lstat, readFile, readdir, realpath } from "node:fs/promises"
import { join } from "node:path"
import { parse } from "smol-toml"
import { OFFICIAL_CHAT_OVERRIDES } from "./OfficialSameHomeLaunchProfile"

export const OFFICIAL_CHAT_POLICY = "readonly-project-companion-v1"
const get = (value: any, key: string): any => key.split(".").reduce((v, k) => v?.[k], value)
const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex")
const unsafeEndpoint = (value: any, expected: string) => value != null && (typeof value !== "string" || value.replace(/\/+$/, "") !== expected)

/** Preflight reads configuration as data. It never edits a source file. The
 * process starts outside the project so project executors/instructions cannot
 * become a new startup layer. Unknown/managed startup layers fail admission. */
export async function inspectOfficialStartup(codexHome: string) {
  const home = await realpath(codexHome)
  const profiles = (await readdir(home)).filter(name => name.endsWith(".config.toml"))
  if (profiles.length > 32) throw Error("CHAT_EXECUTION_POLICY")
  const paths = ["/etc/codex/config.toml", "/etc/codex/managed_config.toml", join(home, "managed_config.toml"), join(home, "config.toml"), ...profiles.map(name => join(home, name))]
  const fingerprints = new Map<string, string>(), servers = new Set<string>()
  const inspect = (config: any) => {
    if (unsafeEndpoint(config.openai_base_url, "https://api.openai.com/v1") || unsafeEndpoint(config.chatgpt_base_url, "https://chatgpt.com/backend-api") || config.model_catalog_json || config.model_instructions_file) throw Error("CHAT_EXECUTION_POLICY")
    for (const name of Object.keys(config.mcp_servers ?? {})) {
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(name) || servers.size >= 128) throw Error("CHAT_EXECUTION_POLICY")
      servers.add(name)
    }
    for (const profile of Object.values(config.profiles ?? {})) inspect(profile)
  }
  const fingerprint = async (path: string) => {
    try {
      const info = await lstat(path)
      if (!info.isFile() || info.size > 1024 * 1024) throw Error("CHAT_EXECUTION_POLICY")
      const bytes = await readFile(path)
      return { hash: digest(bytes), config: parse(bytes.toString("utf8")) }
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { hash: "absent", config: {} }; throw Error("CHAT_EXECUTION_POLICY") }
  }
  for (const path of paths) {
    const value = await fingerprint(path)
    if (path.endsWith("/managed_config.toml") && value.hash !== "absent") throw Error("CHAT_MANAGED_POLICY")
    fingerprints.set(path, value.hash); inspect(value.config)
  }
  return {
    disabledMcpServers: [...servers],
    async assertUnchanged() {
      if ((await readdir(home)).filter(name => name.endsWith(".config.toml")).sort().join() !== profiles.sort().join()) throw Error("CHAT_EXECUTION_POLICY")
      for (const [path, hash] of fingerprints) if ((await fingerprint(path)).hash !== hash) throw Error("CHAT_EXECUTION_POLICY")
    },
  }
}

/** Native effective values, including CLI layer gates omitted from typed tools.
 * This is separate from the legacy isolated-home admission; its rules remain. */
export function assertOfficialConfiguration(requirements: any, effective: any, provider = "openai") {
  if (requirements?.requirements !== null) throw Error("CHAT_MANAGED_POLICY")
  const config = effective?.config
  if (!config || !Array.isArray(effective.layers)) throw Error("CHAT_EXECUTION_POLICY")
  if (config.cli_auth_credentials_store != null && config.cli_auth_credentials_store !== "file") throw Error("CHAT_AUTH_REQUIRED")
  const active = effective.layers.filter((layer: any) => !layer.disabledReason)
  if (active.some((l: any) => !["user", "system", "sessionFlags", "packagedDefaults"].includes(l.name?.type))) throw Error("CHAT_MANAGED_POLICY")
  const flags = active.find((l: any) => l.name?.type === "sessionFlags")?.config
  const mismatches: string[] = []
  for (const [key, expected] of Object.entries(OFFICIAL_CHAT_OVERRIDES)) {
    const actual = get(config, key) ?? get(flags, key)
    if (JSON.stringify(actual) !== JSON.stringify(key === "model_provider" ? provider : expected)) mismatches.push(key)
  }
  if (Object.values(config.mcp_servers ?? {}).some((s: any) => s.enabled !== false)) mismatches.push("mcp_servers")
  if (config.model_catalog_json || config.model_instructions_file || unsafeEndpoint(config.openai_base_url, "https://api.openai.com/v1") || unsafeEndpoint(config.chatgpt_base_url, "https://chatgpt.com/backend-api")) mismatches.push("provider/instructions")
  if (mismatches.length) throw Object.assign(Error("CHAT_EXECUTION_POLICY"), { mismatches })
}
