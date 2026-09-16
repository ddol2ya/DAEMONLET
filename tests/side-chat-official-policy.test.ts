import { describe, expect, it, vi } from "vitest"
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assertOfficialConfiguration, inspectOfficialStartup } from "../electron/main/side-chat/SideChatPermissionPolicy"
import { OFFICIAL_CHAT_OVERRIDES } from "../electron/main/side-chat/OfficialSameHomeLaunchProfile"
import { resolveOfficialParent } from "../electron/main/side-chat/OfficialParentResolver"
import type { AppServerJsonlClient } from "../adapter/codex/app-server/AppServerJsonlClient"

const reflect = () => {
  const config: any = {}
  for (const [key, value] of Object.entries(OFFICIAL_CHAT_OVERRIDES)) { const path = key.split("."); let next = config; for (const k of path.slice(0, -1)) next = next[k] ??= {}; next[path.at(-1)!] = value }
  return { config, layers: [{ name: { type: "user" }, config: { features: { hooks: true } } }, { name: { type: "sessionFlags" }, config: structuredClone(config) }] }
}
describe("official same-home policy admission", () => {
  it("accepts effective restrictions across existing user layers and ignores no requirements", () => {
    const f = reflect(); f.config.mcp_servers = { existing: { enabled: false, command: "sentinel" } }
    expect(() => assertOfficialConfiguration({ requirements: null }, f)).not.toThrow()
    expect(() => assertOfficialConfiguration({ requirements: {} }, f)).toThrow("CHAT_MANAGED_POLICY")
    f.config.mcp_servers.existing.enabled = true
    expect(() => assertOfficialConfiguration({ requirements: null }, f)).toThrow("CHAT_EXECUTION_POLICY")
  })
  it.each(["shell_tool", "hooks", "plugins", "code_mode", "memories", "image_generation"])("rejects effective %s even when flags claim false", feature => {
    const f = reflect(); f.config.features[feature] = true
    expect(() => assertOfficialConfiguration({ requirements: null }, f)).toThrow("CHAT_EXECUTION_POLICY")
  })
  it("rejects uninspected startup layers and endpoint/catalog overrides", () => {
    for (const field of ["model_catalog_json", "model_instructions_file", "openai_base_url", "chatgpt_base_url"]) {
      const f: any = reflect(); f.config[field] = "https://untrusted.invalid"
      expect(() => assertOfficialConfiguration({ requirements: null }, f)).toThrow("CHAT_EXECUTION_POLICY")
    }
    const f = reflect(); f.layers.push({ name: { type: "enterpriseManaged" }, config: {} })
    expect(() => assertOfficialConfiguration({ requirements: null }, f)).toThrow("CHAT_MANAGED_POLICY")
  })
  it("collects MCP entries in profiles and detects config changes without writing", async () => {
    const root = await mkdtemp(join(tmpdir(), "startup-policy-test-"))
    try {
      const path = join(root, "config.toml"), original = '[mcp_servers.base]\ncommand="sentinel"\n[profiles.dev.mcp_servers.profile]\ncommand="sentinel"\n'
      await writeFile(path, original)
      const p = await inspectOfficialStartup(root)
      expect(p.disabledMcpServers).toEqual(["base", "profile"]); await p.assertUnchanged()
      await writeFile(path, original + '\n[features]\nhooks=true\n')
      await expect(p.assertUnchanged()).rejects.toThrow("CHAT_EXECUTION_POLICY")
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it("pages past failed/interrupted turns and never resumes or mutates the parent", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "parent-boundary-test-")))
    try {
      const request = vi.fn(async (method: string, params: any) => method === "thread/read" ? { thread: { id: "p", ephemeral: false, cwd: root, updatedAt: 2 } } : params.cursor ? { data: [{ id: "good", status: "completed", completedAt: 1 }], nextCursor: null } : { data: [{ id: "active", status: "interrupted" }, { id: "bad", status: "failed" }], nextCursor: "older" })
      const result = await resolveOfficialParent({ request } as unknown as AppServerJsonlClient, { threadId: "p", title: "fixture", cwd: root })
      expect(result).toEqual({ lastTurnId: "good", contextAt: 1000 })
      expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/read", "thread/turns/list", "thread/turns/list"])
      await mkdir(join(root, "different"))
      await expect(resolveOfficialParent({ request } as unknown as AppServerJsonlClient, { threadId: "p", title: "fixture", cwd: join(root, "different") })).rejects.toThrow("PARENT_UNSUPPORTED")
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
