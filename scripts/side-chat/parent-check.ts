import { parseArgs } from "node:util"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { writeFile } from "node:fs/promises"
import { readDesktopThreadCatalog } from "../../electron/main/control/DesktopThreadCatalog"
import { inspectParent } from "./parent-inspection"
const { values } = parseArgs({ options: { "codex-home": { type: "string" }, project: { type: "string" }, output: { type: "string" } } })
if (!values.output) throw Error("--output <new-private-report.json> required")
const home = values["codex-home"] ?? process.env.CODEX_HOME ?? join(homedir(), ".codex")
const report: any = { kind: "read-only-existing-parent-suitability", modelCalls: 0, cliProcessesStarted: 0, authRead: false, sourceModified: false, maxCandidates: 64, status: "NOT_RUN", parents: [] }
try {
  const candidates = await readDesktopThreadCatalog(home)
  for (const [index, parent] of candidates.entries()) {
    report.parents.push({ candidate: `recent-${index + 1}`, ...(values.project ? { currentProject: resolve(parent.cwd) === resolve(values.project) } : {}), ...await inspectParent(home, { threadId: parent.id, title: "", cwd: parent.cwd, path: parent.path }) })
  }
  report.status = candidates.length ? "CHECKED" : "NO_LOCAL_CANDIDATES"
} catch { report.status = "BLOCKED_INPUT"; report.reason = "LOCAL_METADATA_INDEX_UNAVAILABLE" }
await writeFile(resolve(values.output), JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 })
console.log(JSON.stringify(report, null, 2))
if (report.status !== "CHECKED") process.exitCode = 1
