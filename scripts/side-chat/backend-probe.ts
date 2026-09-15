import { createServer } from "node:http"
import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, relative } from "node:path"
import { createHash } from "node:crypto"
import { parseArgs } from "node:util"
import { stringify } from "smol-toml"
import { readChatParentContext } from "../../electron/main/side-chat/SideChatParent"
import { SideChatService } from "../../electron/main/side-chat/SideChatService"
import { CodexSideChatBackend, type ChatConnection } from "../../electron/main/side-chat/SideChatBackend"
import { compilePersona } from "../../electron/main/side-chat/PersonaCompiler"
import { neutralPersona } from "../../electron/shared/character-persona"
import { CHAT_LAUNCH_CONSTRAINTS, launchIsolatedChatProcess, writeChatModelCatalog } from "../../electron/main/side-chat/SideChatLaunchProfile"

const { values } = parseArgs({ options: { codex: { type: "string" }, output: { type: "string" }, rawParentBoundary: { type: "boolean", default: false }, crossHome: { type: "boolean", default: false }, hostileParent: { type: "boolean", default: false }, legacyParent: { type: "boolean", default: false }, catalog: { type: "boolean", default: false }, compaction: { type: "boolean", default: false }, instructions: { type: "string", default: "fork" }, environments: { type: "boolean", default: false } } })
if (!values.codex || !values.output) throw Error("Usage: side-chat-backend-probe.mjs --codex <binary> --output <new report.json> [--environments]")
if (values.rawParentBoundary && !values.crossHome) throw Error("--rawParentBoundary requires --crossHome; synthetic upstream reproduction only")
const root = await mkdtemp(join(tmpdir(), "daemonlet-backend-probe-")), cwd = join(root, "project"), state = join(root, "codex")
await mkdir(cwd); await mkdir(state)
const requests: any[] = [], events: any[] = [], connections: ChatConnection[] = []
const report: any = { schemaVersion: 1, kind: "production-backend-real-cli-fake-provider", platform: process.platform, arch: process.arch, version: execFileSync(values.codex, ["--version"], { encoding: "utf8" }).trim(), executableSha256: createHash("sha256").update(await readFile(values.codex)).digest("hex"), realAccountCalls: 0, status: "NOT_RUN", checks: {}, launchConstraints: CHAT_LAUNCH_CONSTRAINTS }
const replies = ["고유한 짧은 한국어 답변 · 72bde", "긴 본문입니다.\n".repeat(350) + "\n```typescript\nconst proof = 'original';\n```", "commentary와 구분한 최종 답변 · 93aca"]
let replyIndex = -1, connectRoot = root
let syntheticBoundary: { lastTurnId: string; contextAt: number; path: string } | null = null
const server = createServer(async (req, res) => {
  let raw = ""; for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 4 * 1024 * 1024) { res.writeHead(413); res.end(); return } }
  if (!req.url?.includes("/responses")) { res.writeHead(404); res.end(); return }
  const request = JSON.parse(raw); requests.push({ ...request, fixturePath: req.url })
  const index = replyIndex, responseId = `resp-${requests.length}`, text = JSON.stringify({ text: index < 0 ? "Synthetic parent" : replies[index], preview: "", expression: "neutral" })
  if (req.url.endsWith("/compact")) {
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ output: [{ type: "compaction", encrypted_content: "DAEMONLET_SYNTHETIC_COMPACTION_72bde" }] })); return
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
  const emit = (type: string, fields: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`)
  emit("response.created", { response: { id: responseId, status: "in_progress", output: [] } })
  const compacting = (request.input ?? []).some((item: any) => item.type === "compaction_trigger")
  if (compacting) {
    const item = { type: "compaction", encrypted_content: "DAEMONLET_SYNTHETIC_COMPACTION_72bde" }
    emit("response.output_item.done", { output_index: 0, item })
    emit("response.completed", { response: { id: responseId, status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } } }); res.end(); return
  }
  const items = (index === 2 ? [{ text: "중간 설명입니다.", phase: "commentary" }, { text, phase: "final_answer" }] : [{ text, phase: "final_answer" }]).map((part, n) => ({ id: `message-${requests.length}-${n}`, type: "message", role: "assistant", status: "completed", phase: part.phase, content: [{ type: "output_text", text: part.text, annotations: [] }] }))
  for (const [n, item] of items.entries()) {
    emit("response.output_item.added", { output_index: n, item: { ...item, status: "in_progress", content: [] } })
    emit("response.output_text.delta", { item_id: item.id, output_index: n, content_index: 0, delta: item.content[0].text })
    emit("response.output_item.done", { output_index: n, item })
  }
  emit("response.completed", { response: { id: responseId, status: "completed", output: items, usage: { input_tokens: values.compaction && index >= 0 && index < 2 ? 200000 : 100, output_tokens: 100, total_tokens: values.compaction && index >= 0 && index < 2 ? 200100 : 200 } } }); res.end()
})
const connect = async () => {
  const connection = await launchIsolatedChatProcess({ executable: values.codex!, root: connectRoot, execution: { model: "gpt-5.6-luna", instructions: values.instructions === "collaboration-mode" ? "collaboration-mode" : "fork", noEnvironment: values.environments } }); connections.push(connection)
  connection.client.onNotification((method, params) => events.push({ method, params }))
  if (values.rawParentBoundary) {
    // White-box tap of this account-free fixture transport only. The shared
    // client deliberately redacts RPC errors and production exposes no raw-log API.
    let buffer = ""
    const input = (connection.client as unknown as { options: { readable: import("node:stream").Readable } }).options.readable
    input.on("data", chunk => {
      buffer += chunk.toString()
      for (let at; (at = buffer.indexOf("\n")) >= 0;) {
        const raw = buffer.slice(0, at); buffer = buffer.slice(at + 1)
        try { const frame = JSON.parse(raw); if (frame.error) (report.syntheticRpcErrors ??= []).push({ code: frame.error.code, message: String(frame.error.message).replaceAll(root, "<fixture>").slice(0, 1000) }) } catch { /* client validates framing */ }
      }
    })
  }
  if (values.crossHome && connectRoot !== root) {
    connection.parentContext = parent => values.rawParentBoundary ? Promise.resolve(syntheticBoundary!) : readChatParentContext(state, parent)
    // Capture only errors from this synthetic native fork, never production data.
    const request = connection.client.request.bind(connection.client)
    connection.client.request = async (method, params, timeout) => {
      try { return await request(method, params, timeout) }
      catch (error) { if (method === "thread/fork") report.nativeForkError = String(error).replaceAll(root, "<fixture>"); throw error }
    }
  }
  return connection
}
const until = async (check: () => boolean) => { const end = Date.now() + 15000; while (Date.now() < end) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 20)) }; throw Error("fixture deadline") }
let service: SideChatService | null = null
try {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as { port: number }
  await writeFile(join(state, "config.toml"), stringify({ ...CHAT_LAUNCH_CONSTRAINTS, ...(values.catalog ? { model_catalog_json: await writeChatModelCatalog(root) } : {}), model: "gpt-5.6-luna", ...(values.compaction ? { model_auto_compact_token_limit: 100000 } : {}), model_provider: "fixture", model_providers: { fixture: { name: "OpenAI", base_url: `http://127.0.0.1:${address.port}/v1`, wire_api: "responses", requires_openai_auth: false } } }), { mode: 0o600 })
  const seed = await connect(); await seed.client.initialize({ name: "daemonlet_seed", title: "Synthetic parent fixture", version: "1" }, "side-chat")
  const requirements: any = await seed.client.request("configRequirements/read", {})
  report.checks.managedRequirementsRead = "PASS"; report.managedRequirementsPresent = requirements.requirements !== null
  const { thread: parent } = await seed.client.request("thread/start", { cwd, historyMode: values.legacyParent ? "legacy" : "paginated", ...(values.hostileParent ? { dynamicTools: [{ name: "forbidden_parent_tool", description: "Synthetic inherited capability", inputSchema: { type: "object", properties: {} } }] } : {}), sandbox: "read-only", approvalPolicy: "never", developerInstructions: "PARENT_POLICY_OLD_72bde" }) as any
  const first: any = await seed.client.request("turn/start", { threadId: parent.id, input: [{ type: "text", text: "Synthetic non-sensitive parent context.", text_elements: [] }] })
  await until(() => events.some(e => e.method === "turn/completed" && e.params.turn.id === first.turn.id))
  report.parentPathFormat = typeof parent.path === "string" ? parent.path.split(".").at(-1) : null
  if (parent.path) report.parentStorage = await readFile(parent.path).then(data => data.subarray(0, 16).toString("utf8")).catch(() => "path not materialized")
  syntheticBoundary = { lastTurnId: first.turn.id, contextAt: Date.now(), path: parent.path }
  const before = await seed.client.request("thread/turns/list", { threadId: parent.id, itemsView: "full" }); await seed.stop()
  if (values.crossHome) {
    connectRoot = join(root, "child"); await mkdir(join(connectRoot, "codex"), { recursive: true })
    const config: any = (await import("smol-toml")).parse(await readFile(join(state, "config.toml"), "utf8"))
    if (values.catalog) config.model_catalog_json = await writeChatModelCatalog(connectRoot)
    await writeFile(join(connectRoot, "codex/config.toml"), stringify(config))
  }
  const compiled = compilePersona("Synthetic voice 72bde", neutralPersona(), "ko")
  const childIds: string[] = []
  service = new SideChatService(() => new CodexSideChatBackend(connect, id => { childIds.push(id) }))
  service.configure(true, "ko"); service.applyPersona({ id: "synthetic", revision: "fixture", label: "Synthetic voice", compiled })
  service.setCandidates([{ threadId: parent.id, title: "Synthetic parent", cwd, path: parent.path }], parent.id)
  report.exchanges = []
  for (let n = 0; n < replies.length; n++) {
    if (values.compaction && n === 2) await connections.at(-1)!.client.request("thread/inject_items", { threadId: childIds[0], items: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Non-sensitive retention pressure. ".repeat(18000) }] }] })
    replyIndex = n; const start = requests.length
    await service.send(`Synthetic question ${n}`)
    if (service.snapshot().error && !childIds.length) {
      report.parentBlocked = service.snapshot().error
      report.childModelRequests = requests.length - start
      break
    }
    const latest = service.snapshot().messages.filter(m => m.role === "assistant").at(-1)
    const outbound = requests.slice(start), request = outbound.at(-1)
    const developer = (request?.input ?? []).filter((item: any) => item.role === "developer").flatMap((item: any) => item.content ?? []).map((part: any) => part.text ?? "").join("\n")
    const users = (request?.input ?? []).filter((item: any) => item.role === "user").flatMap((item: any) => item.content ?? []).map((part: any) => part.text ?? "").join("\n")
    report.exchanges.push({ case: ["short", "long-code", "commentary-final"][n], originalMatches: latest?.text === replies[n], error: service.snapshot().error, modelRequests: outbound.length, developerPolicyPresent: developer.includes(compiled.developerInstructions), developerPolicyCopies: developer.split(compiled.developerInstructions).length - 1, compactionRequests: outbound.filter((r: any) => (r.fixturePath?.endsWith("/compact") || r.input?.some((i: any) => i.type === "compaction_trigger"))).length, userProfilePresent: users.includes(compiled.profileInput), toolNames: (request?.tools ?? []).flatMap((t: any) => t.type === "namespace" ? t.tools.map((x: any) => t.name + "." + x.name) : [t.name ?? t.type]) })
  }
  const active = values.crossHome ? await (async () => { connectRoot = root; const c = await connect(); await c.client.initialize({ name: "parent_readback", title: "Read only validation", version: "1" }, "side-chat"); return c })() : connections.at(-1)!
  report.checks.parentUnchanged = JSON.stringify(before) === JSON.stringify(await active.client.request("thread/turns/list", { threadId: parent.id, itemsView: "full" })) ? "PASS" : "FAIL"
  report.checks.sameChild = childIds.length === 1 ? "PASS" : "FAIL"
  report.checks.serviceOriginalResponses = report.exchanges.length === replies.length && report.exchanges.every((e: any) => e.originalMatches) ? "PASS" : "FAIL"
  report.checks.developerDelivery = report.exchanges.length === replies.length && report.exchanges.every((e: any) => e.developerPolicyPresent) ? "PASS" : "FAIL"
  report.checks.zeroExposedTools = report.exchanges.length === replies.length && report.exchanges.every((e: any) => e.toolNames.length === 0) ? "PASS" : "FAIL"
  report.compactionItems = events.filter(e => e.params?.threadId === childIds[0] && e.method === "item/completed" && e.params.item?.type === "contextCompaction").length
  report.requestShapes = requests.map(r => ({ path: r.fixturePath, itemTypes: r.input?.map((i: any) => i.type), hasCompactionSummary: r.input?.some((i: any) => i.type === "compaction") }))
  report.notifications = events.filter(e => e.params?.threadId === childIds[0] && ["turn/completed", "item/completed"].includes(e.method)).map(e => ({ method: e.method, itemType: e.params.item?.type, phase: e.params.item?.phase, turnItemCount: e.params.turn?.items?.length }))
  const paths: string[] = []
  async function walk(dir: string) { for (const entry of await readdir(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) await walk(path); else if (entry.isFile()) paths.push(path) } }
  await walk(root); report.childDiskMatches = []
  for (const path of paths) { const bytes = await readFile(path); if (childIds.some(id => path.includes(id) || bytes.includes(Buffer.from(id))) || replies.some(text => bytes.includes(Buffer.from(text)))) report.childDiskMatches.push(relative(root, path)) }
  report.checks.childNotOnDisk = report.childDiskMatches.length ? "FAIL" : "PASS"
  report.checks.zeroToolsAllChildRequests = requests.slice(1).length === 0 ? "NOT_OBSERVED" : requests.slice(1).every(r => !r.tools?.length) ? "PASS" : "FAIL"
  report.status = Object.values(report.checks).every(v => v === "PASS") ? "PASS" : "FAIL"
} catch (error) { report.status = "FAIL"; report.error = String(error) }
finally {
  await service?.dispose(); for (const connection of connections) { await connection.stop() }
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
  await rm(root, { recursive: true, force: true })
  report.checks.ownedProcessCleanup = "PASS"; report.fixtureRequests = requests.length
}
await writeFile(resolve(values.output), JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 })
console.log(JSON.stringify(report, null, 2))
if (report.status !== "PASS") process.exitCode = 1
