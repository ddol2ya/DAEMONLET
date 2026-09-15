import { describe, expect, it } from "vitest"
import { assertChatConfiguration } from "../electron/main/side-chat/SideChatPolicy"
import { CHAT_LAUNCH_CONSTRAINTS } from "../electron/main/side-chat/SideChatLaunchProfile"

const configPath = "/fixture/codex/config.toml", catalog = "/fixture/models.json"
function reflected() {
  const owned = { name: { type: "user", file: configPath }, config: structuredClone(CHAT_LAUNCH_CONSTRAINTS) }
  // Match native config/read: typed ToolsV2 omits the actual gates.
  return { config: { ...structuredClone(CHAT_LAUNCH_CONSTRAINTS), tools: {}, model: "gpt-5.6-luna", model_provider: "openai", model_catalog_json: catalog }, layers: [owned] } as any
}
describe("native configuration admission", () => {
  const verify = (value: any) => assertChatConfiguration({ requirements: null }, value, configPath, catalog)
  it("accepts the sole owned reflected profile and discovery without a custom catalog", () => {
    expect(() => verify(reflected())).not.toThrow()
    const discovery = reflected(); delete discovery.config.model_catalog_json
    expect(() => assertChatConfiguration({ requirements: null }, discovery, configPath, null)).not.toThrow()
  })
  it("rejects managed requirements, including an empty requirements object", () => {
    for (const requirements of [{}, { allowedApprovalPolicies: ["never"] }])
      expect(() => assertChatConfiguration({ requirements }, reflected(), configPath, catalog)).toThrow("CHAT_MANAGED_POLICY")
  })
  it.each(["shell", "image", "input", "plan", "web", "mcp", "provider", "model", "catalog", "layer", "missing-layer"])("fails closed for changed %s", field => {
    const value = reflected()
    if (field === "shell") value.config.features.shell_tool = true
    if (field === "image") value.config.features.view_image = true
    if (field === "input") value.layers[0].config.tools.experimental_request_user_input.enabled = true
    if (field === "plan") value.layers[0].config.tools.update_plan.enabled = true
    if (field === "web") value.config.web_search = "live"
    if (field === "mcp") value.config.mcp_servers = { inherited: {} }
    if (field === "provider") value.config.model_providers = { inherited: {} }
    if (field === "model") value.config.model = "unverified"
    if (field === "catalog") value.config.model_catalog_json = "/unverified/catalog.json"
    if (field === "layer") value.layers.push({ name: { type: "system" }, config: { hooks: { enabled: true } } })
    if (field === "missing-layer") value.layers = []
    expect(() => verify(value)).toThrow("CHAT_EXECUTION_POLICY")
  })
})
