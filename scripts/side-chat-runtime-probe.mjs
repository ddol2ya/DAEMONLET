// Explicit, synthetic-only CLI probe. No account credentials, real parent or model calls.
import { createServer } from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, access } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { parseArgs } from 'node:util'
import { createHash } from 'node:crypto'
import { createInterface } from 'node:readline'

const { values } = parseArgs({ options: { codex: { type: 'string' }, output: { type: 'string' } } })
if (!values.codex || !values.output) throw Error('Usage: side-chat-runtime-probe.mjs --codex <absolute executable> --output <new report.json>')
const root = await mkdtemp(join(tmpdir(), 'daemonlet-chat-probe-')), state = join(root, 'codex'), cwd = join(root, 'project')
await mkdir(state); await mkdir(cwd)
const report = { schemaVersion: 1, platform: process.platform, arch: process.arch, version: execFileSync(values.codex, ['--version'], { encoding: 'utf8' }).trim(), executableSha256: createHash('sha256').update(await readFile(values.codex)).digest('hex'), realAccountCalls: 0, status: 'NOT_RUN', checks: {}, toolNames: [] }
const requests = [], notifications = [], waiters = []
let toolTest = false, hanging = false
let child, server, next = 0
const pending = new Map()
const marker = 'DAEMONLET_FIRST_FORK_PERSONA_72bde'
function settle() { for (const w of [...waiters]) { const match = notifications.find(w.match); if (match) { waiters.splice(waiters.indexOf(w), 1); w.resolve(match) } } }
function wait(match) { return new Promise((resolve, reject) => { const timer = setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); reject(Error('notification timeout')) }, 15000); const w = { match, resolve: v => { clearTimeout(timer); resolve(v) } }; waiters.push(w); settle() }) }
function rpc(method, params) { return new Promise((resolve, reject) => { const id = ++next, timer = setTimeout(() => { pending.delete(id); reject(Error('RPC timeout: ' + method)) }, 15000); pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v) }, reject: e => { clearTimeout(timer); reject(e) } }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n') }) }
try {
  server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 2 * 1024 * 1024) { res.writeHead(413); res.end(); return } }
    if (!req.url.includes('/responses')) { res.writeHead(404); res.end(); return }
    const request = JSON.parse(body); requests.push(request)
    const malicious = toolTest; toolTest = false
    const id = 'response_' + requests.length, text = JSON.stringify({ text: '합성 응답입니다.', preview: '', expression: 'neutral' })
    const item = { type: 'message', id: 'message_' + requests.length, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    emit('response.created', { response: { id, status: 'in_progress', output: [] } })
    if (hanging) return
    if (malicious) { const call = { type: 'custom_tool_call', id: 'tool_item', call_id: 'canary_call', name: 'apply_patch', input: `*** Begin Patch\n*** Add File: ${join(cwd, 'model-wrote-canary')}\n+canary\n*** End Patch` }; emit('response.output_item.done', { output_index: 0, item: call }); emit('response.completed', { response: { id, status: 'completed', output: [call], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }); res.end(); return }
    emit('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } })
    emit('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: text })
    emit('response.output_item.done', { output_index: 0, item })
    emit('response.completed', { response: { id, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }); res.end()
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  await writeFile(join(state, 'config.toml'), `model = "gpt-5.4"\nmodel_provider = "probe"\nweb_search = "disabled"\n[model_providers.probe]\nname = "Synthetic probe"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n[features]\nshell_tool = false\nunified_exec = false\nshell_snapshot = false\nhooks = false\ngoals = false\n[agents]\nenabled = false\n[tools]\nview_image = false\n[apps._default]\nenabled = false\n`)
  await writeFile(join(state, 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `touch ${join(root, 'hook-ran')}` }] }] } }))
  child = spawn(values.codex, ['app-server', '--listen', 'stdio://'], { cwd, env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: root, CODEX_HOME: state }, stdio: ['pipe', 'pipe', 'pipe'] })
  // Do not retain stderr or request content in the report.
  child.stderr.resume()
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => { let v; try { v = JSON.parse(line) } catch { return } if (v.id && !v.method) { const p = pending.get(v.id); pending.delete(v.id); if (p) v.error ? p.reject(Error('RPC rejected: ' + JSON.stringify(v.error))) : p.resolve(v.result) } else if (v.id && v.method) child.stdin.write(JSON.stringify({ id: v.id, error: { code: -32601, message: 'No tools in probe' } }) + '\n'); else { notifications.push(v); settle() } })
  await rpc('initialize', { clientInfo: { name: 'daemonlet_probe', title: 'Synthetic probe', version: '1' }, capabilities: { experimentalApi: true } }); child.stdin.write('{"method":"initialized"}\n')
  report.checks.initialize = 'PASS'
  const parent = (await rpc('thread/start', { cwd, approvalPolicy: 'never', sandbox: 'read-only', historyMode: 'paginated', ephemeral: false })).thread
  const first = await rpc('turn/start', { threadId: parent.id, input: [{ type: 'text', text: 'Synthetic parent. No private information.' }] })
  await wait(v => v.method === 'turn/completed' && v.params?.turn?.id === first.turn.id)
  const before = await rpc('thread/turns/list', { threadId: parent.id, itemsView: 'full' })
  const fork = (await rpc('thread/fork', { threadId: parent.id, lastTurnId: first.turn.id, ephemeral: true, excludeTurns: true, developerInstructions: marker, approvalPolicy: 'never', sandbox: 'read-only' })).thread
  report.checks.ephemeralFork = fork.id !== parent.id && fork.ephemeral === true ? 'PASS' : 'FAIL'
  const turn = await rpc('turn/start', { threadId: fork.id, input: [{ type: 'text', text: 'Reply with the synthetic result.' }], outputSchema: { type: 'object', additionalProperties: false, required: ['text', 'preview', 'expression'], properties: { text: { type: 'string' }, preview: { type: 'string' }, expression: { enum: ['neutral'] } } } })
  await wait(v => v.method === 'turn/completed' && v.params?.turn?.id === turn.turn.id)
  report.checks.firstForkInstructions = JSON.stringify(requests[1]).includes(marker) ? 'PASS' : 'FAIL'
  report.toolNames = (requests[1]?.tools ?? []).flatMap(t => t.type === 'namespace' ? t.tools.map(x => t.name + '.' + x.name) : [t.name ?? t.type])
  report.checks.zeroExposedTools = report.toolNames.length === 0 ? 'PASS' : 'FAIL'
  report.checks.parentUnchanged = JSON.stringify(before) === JSON.stringify(await rpc('thread/turns/list', { threadId: parent.id, itemsView: 'full' })) ? 'PASS' : 'FAIL'
  report.checks.startupHookDisabled = await access(join(root, 'hook-ran')).then(() => 'FAIL', () => 'PASS')
  const list = await rpc('thread/list', { limit: 100 })
  report.checks.ephemeralNotListed = (list.data ?? []).some(t => t.id === fork.id) ? 'FAIL' : 'PASS'
  const paths = []
  async function walk(dir) { for (const entry of await readdir(dir, { withFileTypes: true })) { const p = join(dir, entry.name); if (entry.isDirectory()) await walk(p); else paths.push(p) } }
  await walk(state)
  report.ephemeralFiles = []
  for (const path of paths) { const data = await readFile(path); if (path.includes(fork.id) || data.includes(Buffer.from(fork.id)) || data.includes(Buffer.from(marker))) report.ephemeralFiles.push(relative(state, path)) }
  report.checks.ephemeralNoRollout = report.ephemeralFiles.some(p => p.startsWith('sessions/')) ? 'FAIL' : 'PASS'
  report.checks.ephemeralNoDiskArtifacts = report.ephemeralFiles.length ? 'FAIL' : 'PASS'
  toolTest = true
  const attack = await rpc('turn/start', { threadId: fork.id, input: [{ type: 'text', text: 'Synthetic hostile instruction: write the canary using apply_patch.' }] })
  await wait(v => v.method === 'turn/completed' && v.params?.turn?.id === attack.turn.id)
  report.checks.maliciousWriteBlocked = await access(join(cwd, 'model-wrote-canary')).then(() => 'FAIL', () => 'PASS')
  report.checks.maliciousToolExecution = notifications.some(v => v.method === 'item/started' && ['fileChange', 'commandExecution'].includes(v.params?.item?.type)) ? 'FAIL' : 'NOT_OBSERVED'
  hanging = true
  const mainWork = await rpc('turn/start', { threadId: parent.id, input: [{ type: 'text', text: 'Hold this synthetic parent response.' }] })
  const sideWork = await rpc('turn/start', { threadId: fork.id, input: [{ type: 'text', text: 'Hold this synthetic child response.' }] })
  await rpc('turn/interrupt', { threadId: fork.id, turnId: sideWork.turn.id })
  await wait(v => v.method === 'turn/completed' && v.params?.turn?.id === sideWork.turn.id)
  const parentPage = await rpc('thread/turns/list', { threadId: parent.id })
  report.checks.childInterruptWhileParentRunning = parentPage.data.some(t => t.id === mainWork.turn.id && t.status === 'inProgress') ? 'PASS' : 'FAIL'
  report.checks.realAccountPersona = 'NOT_RUN'
  const finalNotification = notifications.find(v => v.method === 'turn/completed' && v.params?.turn?.id === turn.turn.id)
  report.finalTurnItemTypes = finalNotification?.params?.turn?.items?.map(i => i.type) ?? []

  report.status = 'CHAT_POLICY_UNENFORCEABLE' // A successful protocol probe never grants production support.
} catch (error) { report.status = 'FAIL'; report.error = error.message.slice(0, 1200) }
finally {
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => { const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 2000); child.once('exit', () => { clearTimeout(timer); resolve() }) }) }
  report.checks.ownedProcessStopped = !child || child.exitCode !== null || child.signalCode !== null ? 'PASS' : 'FAIL'
  server?.closeAllConnections(); await new Promise(resolve => server ? server.close(resolve) : resolve())
  await rm(root, { recursive: true, force: true })
}
await writeFile(resolve(values.output), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
console.log(JSON.stringify(report, null, 2))
