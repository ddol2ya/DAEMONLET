import { DatabaseSync } from "node:sqlite"
import { createServer } from "node:http"
import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, rename, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, relative } from "node:path"
import { createHash } from "node:crypto"
import { parseArgs } from "node:util"
import { stringify } from "smol-toml"
import { resolveChatParentSource } from "../../electron/main/side-chat/SideChatSource"
import { SideChatService } from "../../electron/main/side-chat/SideChatService"
import { CodexSideChatBackend, type ChatConnection } from "../../electron/main/side-chat/SideChatBackend"
import { compilePersona } from "../../electron/main/side-chat/PersonaCompiler"
import { neutralPersona } from "../../electron/shared/character-persona"
import { CHAT_LAUNCH_CONSTRAINTS, launchIsolatedChatProcess, writeChatModelCatalog } from "../../electron/main/side-chat/SideChatLaunchProfile"
import { launchOfficialSameHomeProcess, OFFICIAL_CHAT_OVERRIDES } from "../../electron/main/side-chat/OfficialSameHomeLaunchProfile"
import { assertOfficialConfiguration, inspectOfficialStartup } from "../../electron/main/side-chat/SideChatPermissionPolicy"
import { inspectSideChatRuntime } from "../../electron/main/side-chat/SideChatPolicy"

const { values } = parseArgs({ options: { codex: { type: "string" }, output: { type: "string" }, officialSameHome: { type: "boolean", default: false }, appendDuringFork: { type: "boolean", default: false }, parentCompaction: { type: "boolean", default: false }, toolHistory: { type: "boolean", default: false }, sourceOffline: { type: "boolean", default: false }, destinationCollision: { type: "boolean", default: false }, nativeLineage: { type: "boolean", default: false }, concurrentParent: { type: "boolean", default: false }, readOnlySource: { type: "boolean", default: false }, rawParentBoundary: { type: "boolean", default: false }, crossHome: { type: "boolean", default: false }, hostileParent: { type: "boolean", default: false }, legacyParent: { type: "boolean", default: false }, catalog: { type: "boolean", default: false }, compaction: { type: "boolean", default: false }, instructions: { type: "string", default: "fork" }, environments: { type: "boolean", default: false } } })
if (!values.codex || !values.output) throw Error("Usage: side-chat-backend-probe.mjs --codex <binary> --output <new report.json> [--environments]")
if (values.officialSameHome && (await inspectSideChatRuntime(values.codex)).runtime.kind !== "official") throw Error("Official runtime required")
if (values.rawParentBoundary && !values.crossHome) throw Error("--rawParentBoundary requires --crossHome; synthetic upstream reproduction only")
if (values.officialSameHome && (values.crossHome || values.catalog || values.readOnlySource || values.sourceOffline || values.destinationCollision)) throw Error("Official same-home does not use custom catalogs, source contracts, or alternate homes")
const root = await realpath(await mkdtemp(join(tmpdir(), "daemonlet-backend-probe-"))), cwd = join(root, "project"), state = join(root, "codex")
await mkdir(cwd); await mkdir(state)
const requests: any[] = [], events: any[] = [], connections: ChatConnection[] = []
const report: any = { schemaVersion: 1, kind: "production-backend-real-cli-fake-provider", platform: process.platform, arch: process.arch, version: execFileSync(values.codex, ["--version"], { encoding: "utf8", env: { HOME: root, CODEX_HOME: state, PATH: "/usr/bin:/bin" } }).trim(), executableSha256: createHash("sha256").update(await readFile(values.codex)).digest("hex"), realAccountCalls: 0, status: "NOT_RUN", checks: {}, launchConstraints: CHAT_LAUNCH_CONSTRAINTS }
const replies = ["고유한 짧은 한국어 답변 · 72bde", "긴 본문입니다.\n".repeat(350) + "\n```typescript\nconst proof = 'original';\n```", "commentary와 구분한 최종 답변 · 93aca"]
let replyIndex = -1, connectRoot = root
const parentGate: { release?: () => void } = {}
let parentRequestHeld = false
let syntheticBoundary: { lastTurnId: string; contextAt: number; path: string } | null = null
const server = createServer(async (req, res) => {
  let raw = ""; for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 4 * 1024 * 1024) { res.writeHead(413); res.end(); return } }
  if (!req.url?.includes("/responses")) { res.writeHead(404); res.end(); return }
  const request = JSON.parse(raw); requests.push({ ...request, fixturePath: req.url })
  const parentRequest = replyIndex < 0
  if (parentRequest && JSON.stringify(request.input).includes("ACTIVE_PARENT_EXCLUDED_5bf3")) {
    parentRequestHeld = true
    await new Promise<void>(resolve => { parentGate.release = resolve })
  }
  const index = parentRequest ? -1 : replyIndex, responseId = `resp-${requests.length}`, text = JSON.stringify({ text: index < 0 ? "Synthetic parent" : replies[index], preview: "", expression: "neutral" })
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
  const startup = values.officialSameHome && replyIndex >= 0 ? await inspectOfficialStartup(state) : null
  const connection = values.officialSameHome && replyIndex >= 0
    ? await launchOfficialSameHomeProcess({ executable: values.codex!, root: join(root, "official-process"), codexHome: state, osHome: join(root, "home"), disabledMcpServers: startup!.disabledMcpServers, modelProvider: "fixture" })
    : await launchIsolatedChatProcess({ executable: values.codex!, root: connectRoot, execution: { model: "gpt-5.6-luna", instructions: values.instructions === "collaboration-mode" ? "collaboration-mode" : "fork", noEnvironment: values.environments } }); connections.push(connection)
  connection.client.onNotification((method, params) => events.push({ method, params }))
  {
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
    connection.parentContext = parent => values.rawParentBoundary ? Promise.resolve(syntheticBoundary!) : resolveChatParentSource(state, parent, values.readOnlySource ? "read-only-source-v1" : "legacy")
    // Capture only errors from this synthetic native fork, never production data.
    const request = connection.client.request.bind(connection.client)
    connection.client.request = async (method, params, timeout) => {
      try {
        if (method === "thread/fork" && values.appendDuringFork) setTimeout(() => parentGate.release?.(), 0)
        const result: any = await request(method, params, timeout)
        if (method === "thread/fork" && values.readOnlySource) report.nativeBoundaryId = result.sourceSnapshot?.terminalTurnId
        return result
      }
      catch (error) { if (method === "thread/fork") report.nativeForkError = String(error).replaceAll(root, "<fixture>"); throw error }
    }
  }
  if (startup) {
    await connection.client.initialize({ name: "daemonlet_side_chat", title: "Official same-home fixture", version: "4" }, "side-chat")
    const verify = async () => {
      await startup.assertUnchanged()
      const requirements = await connection.client.request("configRequirements/read", {})
      const effective = await connection.client.request("config/read", { includeLayers: true })
      try { assertOfficialConfiguration(requirements, effective, "fixture") }
      catch (error) { report.policyMismatches = (error as any).mismatches; report.layerKinds = (effective as any).layers?.map((l: any) => l.name?.type); report.fixtureProviderConfiguration = Object.fromEntries(["openai_base_url", "chatgpt_base_url", "model_catalog_json", "model_instructions_file"].map(key => [key, (effective as any).config?.[key]])); throw error }
    }
    await verify(); connection.beforeTurn = verify
    report.launchConstraints = OFFICIAL_CHAT_OVERRIDES
    report.checks.effectiveOfficialPolicy = "PASS"
  }
  return connection
}
const until = async (check: () => boolean) => { const end = Date.now() + 15000; while (Date.now() < end) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 20)) }; throw Error("fixture deadline") }
let service: SideChatService | null = null
try {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as { port: number }
  const fixtureProvider = { name: "OpenAI", base_url: `http://127.0.0.1:${address.port}/v1`, wire_api: "responses", requires_openai_auth: false }
  await writeFile(join(state, "config.toml"), stringify({ ...CHAT_LAUNCH_CONSTRAINTS, ...(values.catalog ? { model_catalog_json: await writeChatModelCatalog(root) } : {}), model: "gpt-5.6-luna", ...(values.compaction ? { model_auto_compact_token_limit: 100000 } : {}), model_provider: "fixture", model_providers: { fixture: fixtureProvider } }), { mode: 0o600 })
  const seed = await connect(); await seed.client.initialize({ name: "daemonlet_seed", title: "Synthetic parent fixture", version: "1" }, "side-chat")
  const requirements: any = await seed.client.request("configRequirements/read", {})
  report.checks.managedRequirementsRead = "PASS"; report.managedRequirementsPresent = requirements.requirements !== null
  let { thread: parent } = await seed.client.request("thread/start", { cwd, historyMode: values.legacyParent ? "legacy" : "paginated", ...(values.hostileParent ? { dynamicTools: [{ name: "forbidden_parent_tool", description: "Synthetic inherited capability", inputSchema: { type: "object", properties: {} } }] } : {}), sandbox: "read-only", approvalPolicy: "never", developerInstructions: "PARENT_POLICY_OLD_72bde" }) as any
  const first: any = await seed.client.request("turn/start", { threadId: parent.id, input: [{ type: "text", text: "Synthetic non-sensitive parent context.", text_elements: [] }] })
  await until(() => events.some(e => e.method === "turn/completed" && e.params.turn.id === first.turn.id))
  report.parentPathFormat = typeof parent.path === "string" ? parent.path.split(".").at(-1) : null
  if (parent.path) report.parentStorage = await readFile(parent.path).then(data => data.subarray(0, 16).toString("utf8")).catch(() => "path not materialized")
  syntheticBoundary = { lastTurnId: first.turn.id, contextAt: Date.now(), path: parent.path }
  let boundaryTurn = first.turn.id
  if (values.readOnlySource || values.officialSameHome) {
    if (values.toolHistory) await seed.client.request("thread/inject_items", { threadId: parent.id, items: [
      { type: "function_call", name: "exec_command", call_id: "historical-fixture", arguments: JSON.stringify({ cmd: "printf should-never-run" }) },
      { type: "function_call_output", call_id: "historical-fixture", output: "HISTORICAL_TOOL_RESULT_72bde" },
    ] })
    for (let n = 0; n < 12; n++) {
      const turn: any = await seed.client.request("turn/start", { threadId: parent.id, input: [{ type: "text", text: `PAGE_MARKER_${n}_72bde ` + "fixture padding ".repeat(600), text_elements: [] }] })
      await until(() => events.some(e => e.method === "turn/completed" && e.params.turn.id === turn.turn.id)); boundaryTurn = turn.turn.id
    }
    let cursor: string | undefined, pages = 0, turnIds: string[] = []
    do {
      const page: any = await seed.client.request("thread/turns/list", { threadId: parent.id, limit: 2, ...(cursor ? { cursor } : {}) })
      pages++; turnIds.push(...page.data.map((turn: any) => turn.id)); cursor = page.nextCursor
    } while (cursor && pages < 20)
    report.checks.nativeMultiplePages = pages >= 7 && new Set(turnIds).size === 13 ? "PASS" : "FAIL"
    const { thread: other }: any = await seed.client.request("thread/start", { cwd, historyMode: "paginated", sandbox: "read-only", approvalPolicy: "never" })
    const turn: any = await seed.client.request("turn/start", { threadId: other.id, input: [{ type: "text", text: "OTHER_THREAD_EXCLUDED_5bf3", text_elements: [] }] })
    await until(() => events.some(e => e.method === "turn/completed" && e.params.turn.id === turn.turn.id))
  }
  if (values.parentCompaction) {
    await seed.client.request("thread/compact/start", { threadId: parent.id })
    await until(() => events.some(e => e.method === "item/completed" && e.params.threadId === parent.id && e.params.item.type === "contextCompaction"))
    const turn: any = await seed.client.request("turn/start", { threadId: parent.id, input: [{ type: "text", text: "AFTER_PARENT_COMPACTION_72bde", text_elements: [] }] })
    await until(() => events.some(e => e.method === "turn/completed" && e.params.turn.id === turn.turn.id)); boundaryTurn = turn.turn.id
  }
  if (values.nativeLineage) {
    const fork: any = await seed.client.request("thread/fork", { threadId: parent.id, lastTurnId: boundaryTurn, excludeTurns: true, cwd, approvalPolicy: "never", sandbox: "read-only" })
    parent = fork.thread
    const turn: any = await seed.client.request("turn/start", { threadId: parent.id, input: [{ type: "text", text: "NATIVE_LINEAGE_CHILD_72bde", text_elements: [] }] })
    await until(() => events.some(e => e.method === "turn/completed" && e.params.turn.id === turn.turn.id))
    report.checks.nativeLineageCreated = JSON.parse((await readFile(parent.path, "utf8")).split("\n")[0]).payload.history_base ? "PASS" : "FAIL"
  }
  const before = await seed.client.request("thread/turns/list", { threadId: parent.id, itemsView: "full" })
  let parentActive: string | null = null
  if (values.concurrentParent) {
    const turn: any = await seed.client.request("turn/start", { threadId: parent.id, input: [{ type: "text", text: "ACTIVE_PARENT_EXCLUDED_5bf3", text_elements: [] }] })
    parentActive = turn.turn.id; await until(() => parentRequestHeld)
  } else await seed.stop()
  const sourcePrefix = await readFile(parent.path)
  const sourceFiles = async () => {
    const result: Record<string, string> = {}
    const scan = async (dir: string) => { for (const entry of await readdir(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) await scan(path); else if (entry.isFile()) result[relative(state, path)] = createHash("sha256").update(await readFile(path)).digest("hex") } }
    await scan(state); return result
  }
  const idleSource = values.concurrentParent ? null : await sourceFiles()
  const officialSourceBefore = values.officialSameHome ? await sourceFiles() : null
  let childRequestStart = requests.length
  if (values.crossHome) {
    connectRoot = join(root, "child"); await mkdir(join(connectRoot, "codex"), { recursive: true })
    const config: any = (await import("smol-toml")).parse(await readFile(join(state, "config.toml"), "utf8"))
    if (values.catalog) config.model_catalog_json = await writeChatModelCatalog(connectRoot)
    await writeFile(join(connectRoot, "codex/config.toml"), stringify(config))
  }
  if (values.destinationCollision) {
    const collision = await connect(); await collision.client.initialize({ name: "collision_fixture", title: "Fixture", version: "1" }, "side-chat")
    const { thread }: any = await collision.client.request("thread/start", { cwd: join(connectRoot, "project"), historyMode: "paginated", approvalPolicy: "never", sandbox: "read-only" })
    const turn: any = await collision.client.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "DESTINATION_COLLISION_EXCLUDED_5bf3", text_elements: [] }] })
    await until(() => events.some(e => e.method === "turn/completed" && e.params.turn.id === turn.turn.id)); await collision.stop()
    const name = (await readdir(join(connectRoot, "codex"))).find(name => /^state_\d+\.sqlite$/.test(name))!
    const db = new DatabaseSync(join(connectRoot, "codex", name))
    try { db.exec("PRAGMA foreign_keys=OFF"); db.prepare("UPDATE threads SET id=? WHERE id=?").run(parent.id, thread.id); report.checks.destinationCollisionCreated = db.prepare("SELECT id FROM threads WHERE id=?").get(parent.id) ? "PASS" : "FAIL" } finally { db.close() }
    childRequestStart = requests.length
  }
  const compiled = compilePersona("Synthetic voice 72bde", neutralPersona(), "ko")
  const childIds: string[] = []
  service = new SideChatService(() => new CodexSideChatBackend(connect, id => { childIds.push(id) }))
  service.configure(true, "ko"); service.applyPersona({ id: "synthetic", revision: "fixture", label: "Synthetic voice", compiled })
  if (values.officialSameHome) service.setConnectionMode("official-same-home")
  service.setCandidates([{ threadId: parent.id, title: "Synthetic parent", cwd, path: parent.path }], parent.id)
  report.exchanges = []
  for (let n = 0; n < replies.length; n++) {
    if (values.officialSameHome && n === 1) {
      await writeFile(join(cwd, "allowed.ts"), "export const marker = 'SELECTED_PROJECT_LINE_42';\n// second line\n")
      await service.attachFile(join(cwd, "allowed.ts"), 1, 2, service.snapshot().epoch)
    }
    if (values.sourceOffline && n === 1) await rename(state, state + "-offline")
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
    if (values.officialSameHome && n === 1) report.checks.userSelectedFileDelivered = users.includes("SELECTED_PROJECT_LINE_42") && users.includes('1: export const marker') ? "PASS" : "FAIL"
    report.exchanges.push({ case: ["short", "long-code", "commentary-final"][n], originalMatches: latest?.text === replies[n], error: service.snapshot().error, modelRequests: outbound.length, developerPolicyPresent: developer.includes(compiled.developerInstructions), developerPolicyCopies: developer.split(compiled.developerInstructions).length - 1, compactionRequests: outbound.filter((r: any) => (r.fixturePath?.endsWith("/compact") || r.input?.some((i: any) => i.type === "compaction_trigger"))).length, userProfilePresent: users.includes(compiled.profileInput), toolNames: (request?.tools ?? []).flatMap((t: any) => t.type === "namespace" ? t.tools.map((x: any) => t.name + "." + x.name) : [t.name ?? t.type]) })
  }
  if (values.sourceOffline) { await rename(state + "-offline", state); report.checks.sourceClosedFollowup = report.exchanges.length === 3 && report.exchanges.every((e: any) => e.originalMatches) ? "PASS" : "FAIL" }
  if (values.readOnlySource || values.officialSameHome) {
    const firstInput = JSON.stringify(requests[childRequestStart]?.input)
    report.checks.pageBoundaryMarkers = values.parentCompaction ? ((requests[childRequestStart]?.input ?? []).some((item: any) => item.type === "compaction") && firstInput.includes("AFTER_PARENT_COMPACTION_72bde") ? "PASS" : "FAIL") : Array.from({ length: 12 }, (_, n) => `PAGE_MARKER_${n}_72bde`).every(marker => firstInput.includes(marker)) ? "PASS" : "FAIL"
    if (values.toolHistory && !values.parentCompaction) report.checks.nativeToolHistoryReconstructed = firstInput.includes("HISTORICAL_TOOL_RESULT_72bde") ? "PASS" : "FAIL"
    if (values.destinationCollision) report.checks.destinationCollisionExcluded = !firstInput.includes("DESTINATION_COLLISION_EXCLUDED_5bf3") ? "PASS" : "FAIL"
    report.checks.otherThreadExcluded = !firstInput.includes("OTHER_THREAD_EXCLUDED_5bf3") ? "PASS" : "FAIL"
    report.checks.activeParentExcluded = values.appendDuringFork ? (firstInput.includes("ACTIVE_PARENT_EXCLUDED_5bf3") === (report.nativeBoundaryId === parentActive) ? "PASS" : "FAIL") : !firstInput.includes("ACTIVE_PARENT_EXCLUDED_5bf3") ? "PASS" : "FAIL"
    const forkEvent = events.find(e => e.method === "thread/started" && e.params.thread.id === childIds[0])
    report.checks.ephemeralNativeChild = forkEvent?.params.thread.ephemeral === true ? "PASS" : "FAIL"
  }
  if (idleSource && !values.officialSameHome) report.checks.idleSourceBytesAndFilesUnchanged = JSON.stringify(idleSource) === JSON.stringify(await sourceFiles()) ? "PASS" : "FAIL"
  if (parentActive) {
    parentGate.release?.(); await until(() => events.some(e => e.method === "turn/completed" && e.params.turn.id === parentActive))
    const after = await readFile(parent.path)
    report.checks.parentWriterContinued = after.subarray(0, sourcePrefix.length).equals(sourcePrefix) && after.length > sourcePrefix.length && !replies.some(text => after.includes(text)) ? "PASS" : "FAIL"
  }
  const active = values.crossHome ? await (async () => { connectRoot = root; const c = await connect(); await c.client.initialize({ name: "parent_readback", title: "Read only validation", version: "1" }, "side-chat"); return c })() : connections.at(-1)!
  const afterTurns: any = await active.client.request("thread/turns/list", { threadId: parent.id, itemsView: "full" })
  report.checks.parentUnchanged = parentActive ? (afterTurns.data.some((turn: any) => turn.id === parentActive && turn.status === "completed") ? "PASS" : "FAIL") : JSON.stringify(before) === JSON.stringify(afterTurns) ? "PASS" : "FAIL"
  report.checks.sameChild = childIds.length === 1 ? "PASS" : "FAIL"
  report.checks.serviceOriginalResponses = report.exchanges.length === replies.length && report.exchanges.every((e: any) => e.originalMatches) ? "PASS" : "FAIL"
  report.checks.developerDelivery = report.exchanges.length === replies.length && report.exchanges.every((e: any) => e.developerPolicyPresent) ? "PASS" : "FAIL"
  if (values.officialSameHome) report.checks.nativeExecutorsAbsent = report.exchanges.length === replies.length && report.exchanges.every((e: any) => e.toolNames.every((name: string) => values.hostileParent && name === "forbidden_parent_tool")) ? "PASS" : "FAIL"
  else report.checks.zeroExposedTools = report.exchanges.length === replies.length && report.exchanges.every((e: any) => e.toolNames.length === 0) ? "PASS" : "FAIL"
  report.compactionItems = events.filter(e => e.params?.threadId === childIds[0] && e.method === "item/completed" && e.params.item?.type === "contextCompaction").length
  report.requestShapes = requests.map(r => ({ path: r.fixturePath, itemTypes: r.input?.map((i: any) => i.type), hasCompactionSummary: r.input?.some((i: any) => i.type === "compaction") }))
  report.notifications = events.filter(e => e.params?.threadId === childIds[0] && ["turn/completed", "item/completed"].includes(e.method)).map(e => ({ method: e.method, itemType: e.params.item?.type, phase: e.params.item?.phase, turnItemCount: e.params.turn?.items?.length }))
  const paths: string[] = []
  async function walk(dir: string) { for (const entry of await readdir(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) await walk(path); else if (entry.isFile()) paths.push(path) } }
  await walk(root); report.childDiskMatches = []
  for (const path of paths) { const bytes = await readFile(path); if (childIds.some(id => path.includes(id) || bytes.includes(Buffer.from(id))) || replies.some(text => bytes.includes(Buffer.from(text)))) report.childDiskMatches.push(relative(root, path)) }
  if (!values.officialSameHome) report.checks.childNotOnDisk = report.childDiskMatches.length ? "FAIL" : "PASS"
  if (!values.officialSameHome) report.checks.zeroToolsAllChildRequests = requests.slice(childRequestStart).length === 0 ? "NOT_OBSERVED" : requests.slice(childRequestStart).every(r => !r.tools?.length) ? "PASS" : "FAIL"
  if (officialSourceBefore) {
    const after = await sourceFiles()
    report.nativeStoreChanges = [...new Set([...Object.keys(officialSourceBefore), ...Object.keys(after)])].filter(path => officialSourceBefore[path] !== after[path])
    report.checks.userConfigurationPreserved = ["config.toml", "hooks.json"].every(path => officialSourceBefore[path] === after[path]) ? "PASS" : "FAIL"
  }
  report.status = Object.values(report.checks).every(v => v === "PASS") ? "PASS" : "FAIL"
} catch (error) { report.status = "FAIL"; report.error = String(error) }
finally {
  parentGate.release?.(); await service?.dispose(); for (const connection of connections) { await connection.stop() }
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
  await rm(root, { recursive: true, force: true })
  report.checks.ownedProcessCleanup = "PASS"; report.fixtureRequests = requests.length
}
await writeFile(resolve(values.output), JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 })
console.log(JSON.stringify(report, null, 2))
if (report.status !== "PASS") process.exitCode = 1
