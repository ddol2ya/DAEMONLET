import { parseArgs } from "node:util"
import { readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { createHash } from "node:crypto"
import { connectVerifiedSideChat, inspectSideChatRuntime } from "../../electron/main/side-chat/SideChatPolicy"
import { CodexSideChatBackend, type ChatConnection } from "../../electron/main/side-chat/SideChatBackend"
import { compilePersona } from "../../electron/main/side-chat/PersonaCompiler"
import { neutralPersona } from "../../electron/shared/character-persona"

const { values } = parseArgs({ options: { codex: { type: "string" }, home: { type: "string" }, parent: { type: "string" }, output: { type: "string" } } })
if (!values.codex || !values.home || !values.parent || !values.output || !/^[\da-f-]{36}$/.test(values.parent)) throw Error("--codex --home --parent --output required; only the explicitly selected parent is read")
const runtime = await inspectSideChatRuntime(values.codex)
if (runtime.runtime.kind !== "official") throw Error("Official runtime required")
const hash = async (path: string) => readFile(path).then(bytes => createHash("sha256").update(bytes).digest("hex"), () => "absent")
const before = await Promise.all(["config.toml", "hooks.json"].map(name => hash(join(values.home!, name))))
const report: any = { kind: "existing-selected-parent-official-preparation", runtime: runtime.runtime, status: "NOT_RUN", logicalModelSubmissions: 0, nativeHttpRequests: "not instrumented", authentication: "native same-home account/read; no token injection", catalog: "official model/list", parentControlCalls: 0, calls: {} }
let connection: ChatConnection | null = null, backend: CodexSideChatBackend | null = null
try {
  connection = await connectVerifiedSideChat({ executable: runtime.executable, codexHome: values.home })
  const client = connection.client, request = client.request.bind(client)
  client.request = async (method, params, timeout) => {
    if (!["configRequirements/read", "config/read", "account/read", "thread/read", "thread/turns/list", "thread/fork"].includes(method)) throw Error("Preparation forbids model/control calls")
    report.calls[method] = (report.calls[method] ?? 0) + 1
    return request(method, params, timeout)
  }
  const metadata: any = await client.request("thread/read", { threadId: values.parent, includeTurns: false })
  if (typeof metadata.thread?.cwd !== "string") throw Error("PARENT_UNSUPPORTED")
  report.officialMetadata = "PASS"
  report.parentObserverState = "unknown (this is a separate process; not the parent's live observer)"
  const prior: any = await client.request("thread/turns/list", { threadId: values.parent, limit: 100, sortDirection: "desc", itemsView: "notLoaded" })
  report.successfulCompletedTurnsOnFirstPage = prior.data?.filter((t: any) => t.status === "completed").length ?? 0
  const preserved = (prior.data ?? []).filter((t: any) => t.status === "completed").map((t: any) => t.id)
  backend = new CodexSideChatBackend(async () => connection!)
  await backend.open({ threadId: values.parent, cwd: metadata.thread.cwd, sourceHome: values.home, title: "Selected parent" }, compilePersona("Preparation only", neutralPersona(), "ko"))
  report.status = "EXISTING_PARENT_PREPARED"
  const after: any = await client.request("thread/turns/list", { threadId: values.parent, limit: 100, sortDirection: "desc", itemsView: "notLoaded" })
  report.successfulParentBoundariesPreserved = preserved.every((id: string) => after.data.some((t: any) => t.id === id && t.status === "completed"))
} catch (error) { report.status = "BLOCKED_POLICY"; report.code = error instanceof Error && /^(CHAT_|PARENT_|NO_PARENT)/.test(error.message) ? error.message : "PREPARATION_FAILED"; report.stage = (error as any)?.stage ?? "parent-fork" }
finally {
  await backend?.close(); await connection?.stop()
  const after = await Promise.all(["config.toml", "hooks.json"].map(name => hash(join(values.home!, name))))
  report.userConfigUnchanged = before[0] === after[0]; report.userHooksUnchanged = before[1] === after[1]
}
await writeFile(resolve(values.output), JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 })
console.log(JSON.stringify(report, null, 2))
if (report.status !== "EXISTING_PARENT_PREPARED") process.exitCode = 1
