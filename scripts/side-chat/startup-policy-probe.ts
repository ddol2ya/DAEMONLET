import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { createServer } from "node:http"
import { parseArgs } from "node:util"
import { stringify, parse } from "smol-toml"
import { CHAT_LAUNCH_CONSTRAINTS, launchIsolatedChatProcess } from "../../electron/main/side-chat/SideChatLaunchProfile"
const { values } = parseArgs({ options: { codex: { type: "string" }, output: { type: "string" } } })
if (!values.codex || !values.output) throw Error("--codex and --output required")
const report: any = { kind: "startup-hook-mcp-controls", realAccountCalls: 0, trials: [] }
const present = (path: string) => access(path).then(() => true, () => false)
const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'"
for (const restricted of [false, true]) {
  const root = await mkdtemp(join(tmpdir(), "daemonlet-startup-control-")), state = join(root, "codex"), cwd = join(root, "project")
  await mkdir(state); await mkdir(cwd)
  const hookCanary = join(root, "hook-ran"), mcpCanary = join(root, "mcp-ran"), script = join(root, "mcp.cjs")
  await writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(mcpCanary)},'started');require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result:r.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:r.method==='tools/list'?{tools:[]}: {}})+'\\n')});`)
  await writeFile(join(state, "hooks.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: `printf canary > ${quote(hookCanary)}` }] }] } }))
  let calls = 0
  const server = createServer(async (req, res) => { for await (const _ of req) { /* synthetic only */ }; calls++
    const id = `r-${calls}`, item = { type: "message", id: `m-${calls}`, role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "OK", annotations: [] }] }
    res.writeHead(200, { "content-type": "text/event-stream" })
    for (const event of [{ type: "response.created", response: { id } }, { type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response: { id, output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    res.end()
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  await writeFile(join(state, "config.toml"), stringify({ ...CHAT_LAUNCH_CONSTRAINTS, features: { ...CHAT_LAUNCH_CONSTRAINTS.features, hooks: !restricted }, mcp_servers: { fixture: { command: process.execPath, args: [script], enabled: !restricted } }, model: "gpt-5.6-luna", model_provider: "fixture", model_providers: { fixture: { name: "OpenAI", base_url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, wire_api: "responses", requires_openai_auth: false } } }))
  // Review only our known canary through the normal discovery hash; never use
  // the runtime's bypass-hook-trust option or change managed/user hooks.
  const file = join(state, "config.toml"), config: any = parse(await readFile(file, "utf8"))
  const actualHooks = config.features.hooks; config.features.hooks = true
  await writeFile(file, stringify(config))
  const discovery = await launchIsolatedChatProcess({ executable: values.codex, root })
  await discovery.client.initialize({ name: "daemonlet_hook_review_fixture", title: "Canary review", version: "1" }, "side-chat")
  const listed: any = await discovery.client.request("hooks/list", { cwds: [cwd] })
  const found = listed.data.flatMap((entry: any) => entry.hooks).filter((hook: any) => hook.source === "user" && hook.handlerType === "command" && hook.command === `printf canary > ${quote(hookCanary)}`)
  if (found.length !== 1) throw Error("Known canary was not discovered")
  await discovery.stop()
  config.features.hooks = actualHooks; config.hooks = { state: { [found[0].key]: { trusted_hash: found[0].currentHash } } }
  await writeFile(file, stringify(config))
  const c = await launchIsolatedChatProcess({ executable: values.codex, root })
  const trial: any = { restricted, phases: [], result: "NOT_RUN" }
  const check = async (phase: string) => trial.phases.push({ phase, hook: await present(hookCanary), mcp: await present(mcpCanary), modelCalls: calls })
  try {
    await check("spawn")
    await c.client.initialize({ name: "daemonlet_startup_fixture", title: "Startup fixture", version: "1" }, "side-chat"); await check("initialize")
    const { thread } = await c.client.request("thread/start", { cwd, historyMode: "paginated", sessionStartSource: "startup", ephemeral: false, approvalPolicy: "never", sandbox: "read-only" }) as any
    await check("thread/start")
    let complete = false
    c.client.onNotification((method) => { if (method === "turn/completed") complete = true })
    await c.client.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "Synthetic", text_elements: [] }], ...(restricted ? { environments: [] } : {}) })
    const deadline = Date.now() + 15000
    while (!complete && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    if (!complete) throw Error("turn timeout")
    await check("turn/completed")
    const history: any = await c.client.request("thread/turns/list", { threadId: thread.id })
    await c.client.request("thread/fork", { threadId: thread.id, lastTurnId: history.data[0].id, ephemeral: true, excludeTurns: true, cwd, approvalPolicy: "never", sandbox: "read-only" }); await check("fork")
    const hook = await present(hookCanary), mcp = await present(mcpCanary)
    trial.result = (restricted ? !hook && !mcp : hook && mcp) ? "PASS" : "FAIL"
  } catch (error) { trial.result = "FAIL"; trial.error = String(error) }
  finally { await c.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }) }
  report.trials.push(trial)
}
report.status = report.trials.every((t: any) => t.result === "PASS") ? "PASS" : "FAIL"
await writeFile(resolve(values.output), JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 }); console.log(JSON.stringify(report, null, 2))
