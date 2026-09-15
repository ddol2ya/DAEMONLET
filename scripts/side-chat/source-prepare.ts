import { createServer } from "node:http"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { stringify } from "smol-toml"
import { readDesktopThreadCatalog } from "../../electron/main/control/DesktopThreadCatalog"
import { resolveChatParentSource } from "../../electron/main/side-chat/SideChatSource"
import { CodexSideChatBackend, type ChatConnection } from "../../electron/main/side-chat/SideChatBackend"
import { CHAT_LAUNCH_CONSTRAINTS, launchIsolatedChatProcess, writeChatModelCatalog } from "../../electron/main/side-chat/SideChatLaunchProfile"
import { compilePersona } from "../../electron/main/side-chat/PersonaCompiler"
import { neutralPersona } from "../../electron/shared/character-persona"
import { chatError } from "../../electron/main/side-chat/SideChatService"

const { values } = parseArgs({ options: { codex: { type: "string" }, "codex-home": { type: "string" }, "thread-id": { type: "string" }, project: { type: "string" }, output: { type: "string" } } })
if (!values.codex || !values.output || !values.project) throw Error("--codex --project --output required; select --thread-id or the current CODEX_THREAD_ID")
const selected = values["thread-id"] ?? process.env.CODEX_THREAD_ID
if (!selected) throw Error("Explicit parent selection required")
const home = values["codex-home"] ?? process.env.CODEX_HOME ?? join(homedir(), ".codex")
const root = await mkdtemp(join(tmpdir(), "daemonlet-source-prepare-"))
const report: any = { kind: "existing-paginated-parent-native-preparation", status: "NOT_RUN", cliProcessesStarted: 0, authRead: false, modelCalls: 0, parentCommands: 0, selectedCandidates: 1, preparedCandidates: 0, runtime: "custom-read-only-source-v1", executableSha256: createHash("sha256").update(await readFile(values.codex)).digest("hex") }
let backend: CodexSideChatBackend | null = null, connection: ChatConnection | null = null
const server = createServer(async (req, res) => { report.modelCalls++; req.resume(); res.writeHead(403); res.end() })
try {
  const catalog = await readDesktopThreadCatalog(home)
  const parent = catalog.find(row => row.id === selected && resolve(row.cwd) === resolve(values.project!))
  if (!parent) throw Error("NO_PARENT")
  const selectedParent = { threadId: parent.id, title: "", cwd: parent.cwd, path: parent.path }
  const source = await resolveChatParentSource(home, selectedParent, "read-only-source-v1")
  if (!("readOnlySource" in source)) throw Error("SOURCE_SCHEMA")
  report.metadata = "CHECKED"; report.format = "paginated"
  await new Promise<void>((yes, no) => { server.once("error", no); server.listen(0, "127.0.0.1", yes) })
  await mkdir(join(root, "codex"), { mode: 0o700 })
  await writeFile(join(root, "codex/config.toml"), stringify({ ...CHAT_LAUNCH_CONSTRAINTS, model_catalog_json: await writeChatModelCatalog(root), model: "gpt-5.6-luna", cli_auth_credentials_store: "ephemeral", model_provider: "fixture", model_providers: { fixture: { name: "OpenAI", base_url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, wire_api: "responses", requires_openai_auth: false } } }), { mode: 0o600 })
  backend = new CodexSideChatBackend(async () => {
    connection = await launchIsolatedChatProcess({ executable: values.codex!, root, execution: { model: "gpt-5.6-luna", instructions: "collaboration-mode", noEnvironment: true } }); report.cliProcessesStarted++
    connection.parentContext = parent => resolveChatParentSource(home, parent, "read-only-source-v1")
    const request = connection.client.request.bind(connection.client)
    connection.client.request = async (method, params, timeout) => {
      if (!["initialize", "thread/fork"].includes(method)) { report.parentCommands++; throw Error("SOURCE_FORK_CONTRACT") }
      const result: any = await request(method, params, timeout)
      if (method === "thread/fork") {
        const s = result.sourceSnapshot
        report.source = { files: s?.sourceFiles, scannedBytes: s?.scannedBytes, contextBytes: s?.contextBytes, snapshotDigestPresent: /^[a-f0-9]{64}$/.test(s?.snapshotSha256), terminalBoundary: "NATIVE_PREPARED" }
      }
      return result
    }
    return connection
  })
  await backend.open(selectedParent, compilePersona("Preparation fixture", neutralPersona(), "ko"))
  report.preparedCandidates = 1
  report.status = report.modelCalls === 0 && report.parentCommands === 0 ? "EXISTING_PARENT_PREPARED" : "FAIL"
} catch (error) { report.status = "BLOCKED_PREPARATION"; report.reason = chatError(error) }
finally {
  await backend?.close()
  server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
  await rm(root, { recursive: true, force: true })
  report.ownedCleanup = "COMPLETE"
}
await writeFile(resolve(values.output), JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 })
console.log(JSON.stringify(report, null, 2))
if (report.status !== "EXISTING_PARENT_PREPARED") process.exitCode = 1
