import { deflateSync } from "node:zlib"
import { createServer } from "node:http"
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { parseArgs } from "node:util"
import { stringify } from "smol-toml"
import { createHash } from "node:crypto"
import { FIXTURE_MODEL_CATALOG, FIXTURE_CONSTRAINTS, launchFixtureParent, writeFixtureCatalog } from "./fixture-process"
import { CodexSideChatBackend, type ChatConnection } from "../../electron/main/side-chat/SideChatBackend"
import { compilePersona } from "../../electron/main/side-chat/PersonaCompiler"
import { neutralPersona } from "../../electron/shared/character-persona"
import { launchOfficialFixture } from "./fixture-process"
import { inspectSideChatRuntime } from "../../electron/main/side-chat/SideChatPolicy"
const { values } = parseArgs({ options: { tool: { type: "string" }, codex: { type: "string" }, output: { type: "string" } } })
if (!values.codex || !values.output) throw Error("--codex and --output required")
await inspectSideChatRuntime(values.codex)
const tools = ["apply_patch", "view_image", "exec_command", "request_user_input", "python", "node", "build", "test", "network", "functions.exec", "js_repl", "web_search", "forbidden_parent_tool"]
if (values.tool && !tools.some(name => name === values.tool)) throw Error("Unknown --tool; no controls executed")
const report: any = { kind: "real-cli-tool-positive-negative-controls", realAccountCalls: 0, executableSha256: createHash("sha256").update(await readFile(values.codex)).digest("hex"), trials: [] }
function pngFixture() {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]), header = Buffer.alloc(4), crc = Buffer.alloc(4)
    header.writeUInt32BE(data.length)
    let value = 0xffffffff
    for (const byte of body) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0) }
    crc.writeUInt32BE((value ^ 0xffffffff) >>> 0)
    return Buffer.concat([header, body, crc])
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(16, 0); header.writeUInt32BE(16, 4); header[8] = 8; header[9] = 2
  const pixels = Buffer.alloc(16 * (1 + 16 * 3), 128)
  for (let y = 0; y < 16; y++) pixels[y * 49] = 0
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))])
}
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const until = async (fn: () => boolean) => { const end = Date.now() + 15000; while (Date.now() < end) { if (fn()) return; await wait(20) }; throw Error("fixture timeout") }
for (const name of tools.filter(name => !values.tool || values.tool === name)) for (const restricted of (["functions.exec", "js_repl", "web_search", "forbidden_parent_tool"].includes(name) ? [true] : [false, true])) {
  const root = await mkdtemp(join(tmpdir(), "daemonlet-tool-control-")), cwd = join(root, "project"), state = join(root, "codex")
  await mkdir(cwd); await mkdir(state)
  await writeFile(join(cwd, "read-canary.txt"), "READ_CANARY_993eca")
  await writeFile(join(cwd, "image.png"), pngFixture())
  const script = join(cwd, "marker.cjs")
  await writeFile(script, `const done=()=>{require('node:fs').writeFileSync('exec-canary.txt','EXEC_CANARY_993eca');process.stdout.write(require('node:fs').readFileSync('read-canary.txt'))};if(process.argv[2]==='network')require('node:http').get(process.argv[3],r=>{r.resume();r.on('end',done)});else done();`)
  const commandTool = ["exec_command", "python", "node", "build", "test", "network"].includes(name)
  const toolName = commandTool ? "exec_command" : name
  let armed = false, count = 0, serverCalls = 0, networkCalls = 0
  const requests: any[] = [], events: any[] = [], connections: ChatConnection[] = []
  const trial: any = { name, restricted, result: "NOT_RUN" }
  const server = createServer(async (req, res) => {
    if (req.url === "/sentinel") { networkCalls++; res.writeHead(200); res.end("NETWORK_CANARY"); return }
    let raw = ""; for await (const chunk of req) raw += chunk
    const request = JSON.parse(raw); requests.push(request)
    const attack = armed; armed = false
    const id = `response-${++count}`
    const input = name === "apply_patch" ? "*** Begin Patch\n*** Add File: patch-canary.txt\n+PATCH_CANARY_993eca\n*** End Patch\n" : ""
    const cmd = name === "exec_command" ? "cat read-canary.txt; printf EXEC_CANARY_993eca > exec-canary.txt" : name === "python" ? `/usr/bin/python3 -c 'from pathlib import Path; Path("exec-canary.txt").write_text("EXEC_CANARY_993eca"); print(Path("read-canary.txt").read_text())'` : `'${process.execPath}' '${script}' ${name} http://127.0.0.1:${(server.address() as { port: number }).port}/sentinel`
    const args = name === "view_image" ? { path: join(cwd, "image.png") } : commandTool ? { cmd, workdir: cwd, max_output_tokens: 100 } : name === "request_user_input" ? { questions: [{ id: "confirm", header: "Fixture", question: "Synthetic question?", options: [{ label: "Yes", description: "Fixture yes" }, { label: "No", description: "Fixture no" }] }] } : { code: `require('fs').writeFileSync(${JSON.stringify(join(cwd, "exec-canary.txt"))},'forbidden')`, query: "fixture", path: join(cwd, "read-canary.txt") }
    const item = attack ? name === "apply_patch"
      ? { type: "custom_tool_call", id: `item-${count}`, call_id: `call-${count}`, name, input }
      : { type: "function_call", id: `item-${count}`, call_id: `call-${count}`, name: toolName, arguments: JSON.stringify(args) }
      : { type: "message", id: `item-${count}`, role: "assistant", status: "completed", phase: "final_answer", content: [{ type: "output_text", text: JSON.stringify({ text: "Fixture completed", preview: "", expression: "neutral" }), annotations: [] }] }
    res.writeHead(200, { "content-type": "text/event-stream" })
    const emit = (type: string, fields: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`)
    emit("response.created", { response: { id, status: "in_progress", output: [] } })
    emit("response.output_item.added", { output_index: 0, item })
    emit("response.output_item.done", { output_index: 0, item })
    emit("response.completed", { response: { id, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }); res.end()
  })
  const connect = async () => {
    const c = restricted && armed
      ? await launchOfficialFixture({ executable: values.codex!, root: join(root, "official-process"), codexHome: state, osHome: join(root, "home"), disabledMcpServers: [] })
      : await launchFixtureParent({ executable: values.codex!, root, execution: { model: "gpt-5.6-luna", noEnvironment: restricted, instructions: "collaboration-mode" } })
    connections.push(c); c.client.onNotification((method, params) => events.push({ method, params })); c.client.onServerRequest(r => { serverCalls++; if (!c.execution?.mode) void c.client.rejectServerRequest(r.id) }); return c
  }
  let backend: CodexSideChatBackend | null = null
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as { port: number }).port
    const constraints = restricted ? FIXTURE_CONSTRAINTS : { ...FIXTURE_CONSTRAINTS, sandbox_mode: "workspace-write", features: { ...FIXTURE_CONSTRAINTS.features, shell_tool: true, view_image: true }, tools: { experimental_request_user_input: { enabled: true }, update_plan: { enabled: false } } }
    const catalog = restricted ? null : await writeFixtureCatalog(root)
    if (!restricted && catalog) await writeFile(catalog, JSON.stringify({ models: [{ ...FIXTURE_MODEL_CATALOG.models[0], shell_type: "unified_exec", apply_patch_tool_type: "freeform", input_modalities: ["text", "image"] }] }))
    await writeFile(join(state, "config.toml"), stringify({ ...constraints, ...(catalog ? { model_catalog_json: catalog } : {}), model: "gpt-5.6-luna", model_provider: "fixture", model_providers: { fixture: { name: "OpenAI", base_url: `http://127.0.0.1:${port}/v1`, wire_api: "responses", requires_openai_auth: false } } }))
    const seed = await connect(); await seed.client.initialize({ name: "daemonlet_tool_fixture", title: "Tool fixture", version: "1" }, "side-chat")
    const { thread } = await seed.client.request("thread/start", { cwd, approvalPolicy: "never", sandbox: restricted ? "read-only" : "workspace-write", historyMode: "paginated", ...(name === "forbidden_parent_tool" ? { dynamicTools: [{ name, description: "Forbidden inherited client tool", inputSchema: { type: "object", properties: {} } }] } : {}) }) as any
    const initial = await seed.client.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "Synthetic parent", text_elements: [] }], ...(restricted ? { environments: [] } : {}) }) as any
    await until(() => events.some(e => e.method === "turn/completed" && e.params.turn.id === initial.turn.id))
    const start = requests.length
    armed = true
    if (restricted) {
      await seed.stop()
      backend = new CodexSideChatBackend(connect)
      await backend.open({ threadId: thread.id, cwd, title: "Synthetic parent" }, compilePersona("Synthetic", neutralPersona(), "ko"))
      await backend.send("Adversarial fixture. Do not execute tools.")
    } else {
      const next = await seed.client.request("turn/start", { threadId: thread.id, ...(name === "network" ? { sandboxPolicy: { type: "workspaceWrite", writableRoots: [cwd], networkAccess: true } } : {}), input: [{ type: "text", text: "Account-free positive tool control", text_elements: [] }], collaborationMode: { mode: name === "request_user_input" ? "plan" : "default", settings: { model: "gpt-5.6-luna", reasoning_effort: null, developer_instructions: "Synthetic positive control." } } }) as any
      await until(() => events.some(e => e.method === "turn/completed" && e.params.turn.id === next.turn.id))
    }
    const patch = await access(join(cwd, "patch-canary.txt")).then(() => true, () => false), exec = await access(join(cwd, "exec-canary.txt")).then(() => true, () => false)
    const after = requests.slice(start), wire = JSON.stringify(after)
    const hasImage = (value: any): boolean => Boolean(value && typeof value === "object" && (value.type === "input_image" || Object.values(value).some(hasImage)))
    const imageRead = after.some(hasImage)
    trial.toolFeedback = after.flatMap(r => r.input ?? []).filter((i: any) => ["function_call_output", "custom_tool_call_output"].includes(i.type)).map((i: any) => ({ type: i.type, text: typeof i.output === "string" ? i.output.replaceAll(root, "<fixture>").slice(0, 500) : "structured output" }))
    const observed = name === "apply_patch" ? patch : name === "network" ? networkCalls > 0 : commandTool ? exec && wire.includes("READ_CANARY_993eca") : name === "view_image" ? imageRead : name === "request_user_input" ? serverCalls > 0 : patch || exec || imageRead
    const names = (after[0]?.tools ?? []).flatMap((t: any) => t.type === "namespace" ? t.tools.map((x: any) => `${t.name}.${x.name}`) : [t.name ?? t.type])
    const denied = /unsupported (custom tool )?call/.test(wire) || name === "forbidden_parent_tool" && wire.includes("read-only companion does not execute tools")
    Object.assign(trial, { exposed: names, actualExecutionObserved: observed, patchCanary: patch, execCanary: exec, imageContentReturned: imageRead, clientRequests: serverCalls, networkReceiverCalls: networkCalls, modelRequests: after.length, unsupportedToolReported: denied, result: restricted ? !observed && denied ? "PASS" : "FAIL" : observed ? "PASS" : "FAIL" })
  } catch (error) { trial.result = "FAIL"; trial.error = String(error) }
  finally { await backend?.close(); for (const c of connections) await c.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }) }
  report.trials.push(trial)
}
report.status = report.trials.every((t: any) => t.result === "PASS") ? "PASS" : "FAIL"
await writeFile(resolve(values.output), JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 }); console.log(JSON.stringify(report, null, 2))
