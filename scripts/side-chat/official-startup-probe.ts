import { createServer } from "node:http"
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { stringify } from "smol-toml"
import { FIXTURE_CONSTRAINTS, launchFixtureParent } from "./fixture-process"
import { launchOfficialFixture } from "./fixture-process"
import { inspectSideChatRuntime } from "../../electron/main/side-chat/SideChatPolicy"
import { assertOfficialConfiguration, inspectOfficialStartup } from "../../electron/main/side-chat/SideChatPermissionPolicy"
import { CodexSideChatBackend, type ChatConnection } from "../../electron/main/side-chat/SideChatBackend"
import { compilePersona } from "../../electron/main/side-chat/PersonaCompiler"
import { neutralPersona } from "../../electron/shared/character-persona"

const { values } = parseArgs({ options: { codex: { type: "string" }, output: { type: "string" } } })
if (!values.codex || !values.output) throw Error("--codex <official native> --output <new private report> required")
const runtime = await inspectSideChatRuntime(values.codex)
if (runtime.runtime.kind !== "official") throw Error("Official runtime required")
const root = await realpath(await mkdtemp(join(tmpdir(), "daemonlet-official-startup-")))
const state = join(root, "codex"), cwd = join(root, "project")
await mkdir(state); await mkdir(cwd)
const hookCanary = join(root, "hook-ran"), mcpCanary = join(root, "mcp-ran"), notifyCanary = join(root, "notify-ran")
const size = (path: string) => readFile(path).then(b => b.length, () => 0)
const counts = async () => ({ hook: await size(hookCanary), mcp: await size(mcpCanary), notify: await size(notifyCanary) })
const connections: ChatConnection[] = [], events: any[] = []
let requests = 0, backend: CodexSideChatBackend | null = null
const report: any = { kind: "official-same-home-startup-sentinels", runtime: runtime.runtime, realAccountCalls: 0, phases: [], checks: {}, status: "NOT_RUN" }
const server = createServer(async (req, res) => {
  for await (const _ of req) { /* fixture requests contain no user data */ }
  const id = `r-${++requests}`, item = { type: "message", id: `m-${requests}`, role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: JSON.stringify({ text: "Fixture reply", preview: "", expression: "neutral" }), annotations: [] }] }
  res.writeHead(200, { "content-type": "text/event-stream" })
  for (const event of [{ type: "response.created", response: { id } }, { type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response: { id, output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  res.end()
})
const until = async (fn: () => boolean) => { const end = Date.now() + 15000; while (Date.now() < end) { if (fn()) return; await new Promise(resolve => setTimeout(resolve, 20)) }; throw Error("fixture timeout") }
const seed = async () => {
  const c = await launchFixtureParent({ executable: runtime.executable, root }); connections.push(c)
  c.client.onNotification((method, params) => events.push({ method, params }))
  await c.client.initialize({ name: "daemonlet_sentinel_parent", title: "Synthetic parent", version: "1" }, "side-chat")
  return c
}
try {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const script = join(root, "mcp.cjs")
  await writeFile(script, `require('fs').appendFileSync(${JSON.stringify(mcpCanary)},${JSON.stringify("start\n")});require('readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result:r.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'sentinel',version:'1'}}:r.method==='tools/list'?{tools:[]}: {}})+${JSON.stringify("\n")})});`)
  const hookCommand = `printf canary >> '${hookCanary}'`
  const hookBytes = JSON.stringify({ hooks: Object.fromEntries(["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"].map(event => [event, [{ hooks: [{ type: "command", command: hookCommand }] }]])) })
  await writeFile(join(state, "hooks.json"), hookBytes)
  const config: any = { ...FIXTURE_CONSTRAINTS, features: { ...FIXTURE_CONSTRAINTS.features, hooks: true, shell_tool: true }, notify: ["/bin/sh", "-c", `printf notify >> '${notifyCanary}'`], mcp_servers: { sentinel: { command: process.execPath, args: [script], enabled: true } }, model: "gpt-5.6-luna", model_provider: "fixture", model_providers: { fixture: { name: "OpenAI", base_url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, wire_api: "responses", requires_openai_auth: false } } }
  await writeFile(join(state, "config.toml"), stringify(config))
  const review = await seed()
  const listed: any = await review.client.request("hooks/list", { cwds: [cwd] })
  const known = listed.data.flatMap((d: any) => d.hooks).filter((h: any) => h.command === hookCommand)
  if (known.length < 3) throw Error("Sentinel hooks not discovered")
  await review.stop()
  config.hooks = { state: Object.fromEntries(known.map((h: any) => [h.key, { trusted_hash: h.currentHash }])) }
  const original = stringify(config)
  await writeFile(join(state, "config.toml"), original)
  const parent = await seed()
  const { thread }: any = await parent.client.request("thread/start", { cwd, sessionStartSource: "startup", historyMode: "paginated", approvalPolicy: "never", sandbox: "workspace-write" })
  const first: any = await parent.client.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "Synthetic sentinel parent", text_elements: [] }] })
  await until(() => events.some(e => e.method === "turn/completed" && e.params.turn.id === first.turn.id))
  await new Promise(resolve => setTimeout(resolve, 150))
  const baseline = await counts()
  const parentConfig = await readFile(join(state, "config.toml"), "utf8")
  report.fixtureParentConfigChanged = parentConfig !== original
  report.positiveParent = baseline
  report.checks.positiveHookMcpNotify = Object.values(baseline).every(n => n > 0) ? "PASS" : "FAIL"
  const snapshot = async (phase: string) => report.phases.push({ phase, counts: await counts(), modelRequests: requests })
  const startup = await inspectOfficialStartup(state)
  backend = new CodexSideChatBackend(async () => {
    const c = await launchOfficialFixture({ executable: runtime.executable, root: join(root, "child-process"), codexHome: state, osHome: join(root, "home"), disabledMcpServers: startup.disabledMcpServers }); connections.push(c)
    await snapshot("spawn")
    await c.client.initialize({ name: "daemonlet_side_chat", title: "Read-only sentinel child", version: "4" }, "side-chat"); await snapshot("initialize")
    const verify = async () => {
      await startup.assertUnchanged()
      const effective: any = await c.client.request("config/read", { includeLayers: true })
      assertOfficialConfiguration(await c.client.request("configRequirements/read", {}), { ...effective, config: { ...effective.config, model_provider: "openai" } })
    }
    await verify(); c.beforeTurn = verify
    return c
  })
  const fork = await backend.open({ threadId: thread.id, cwd, title: "Synthetic parent" }, compilePersona("Synthetic", neutralPersona(), "ko")); await snapshot("fork")
  await backend.send("Synthetic child first"); await snapshot("first-turn")
  await backend.send("Synthetic child follow-up"); await snapshot("follow-up")
  await backend.close(); await snapshot("child-close")
  report.checks.noChildSentinels = report.phases.every((p: any) => JSON.stringify(p.counts) === JSON.stringify(baseline)) ? "PASS" : "FAIL"
  report.checks.noStartupModelRequests = report.phases.filter((p: any) => ["spawn", "initialize", "fork"].includes(p.phase)).every((p: any) => p.modelRequests === 1) ? "PASS" : "FAIL"
  report.checks.configAndHooksUnchanged = await readFile(join(state, "config.toml"), "utf8") === parentConfig && await readFile(join(state, "hooks.json"), "utf8") === hookBytes ? "PASS" : "FAIL"
  if (parentConfig !== original) report.syntheticParentConfigAdditions = parentConfig.split("\n").filter(line => !original.split("\n").includes(line)).map(line => line.replaceAll(root, "<fixture>"))
  const next: any = await parent.client.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "Parent continues after child close", text_elements: [] }] })
  await until(() => events.some(e => e.method === "turn/completed" && e.params.turn.id === next.turn.id))
  report.checks.parentStillOperates = "PASS"
  const list: any = await parent.client.request("thread/list", { limit: 100 })
  report.checks.childAbsentFromStoredObserverList = list.data.every((t: any) => t.id !== fork.threadId) ? "PASS" : "FAIL"
  report.status = Object.values(report.checks).every(v => v === "PASS") ? "PASS" : "FAIL"
} catch (error) { report.status = "FAIL"; report.error = String(error).replaceAll(root, "<fixture>") }
finally {
  await backend?.close(); for (const c of connections) await c.stop()
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
  await rm(root, { recursive: true, force: true })
}
await writeFile(resolve(values.output), JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 })
console.log(JSON.stringify(report, null, 2)); if (report.status !== "PASS") process.exitCode = 1
