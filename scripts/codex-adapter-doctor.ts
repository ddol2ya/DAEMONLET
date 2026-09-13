#!/usr/bin/env node
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { runDoctor } from "../adapter/codex/doctor/CodexAdapterDoctor.ts"

const report = await runDoctor({
  codexPath: process.env.CODEX_PATH,
  codexHome: resolve(process.env.CODEX_HOME ?? join(homedir(), ".codex")),
  dataDir: resolve(process.env.CODEX_PET_DATA_DIR ?? join(homedir(), ".codex-pet")),
})

if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2))
else {
  console.log(`Codex: ${report.codex.path ?? "not found"} (${report.codex.version ?? "unknown version"})`)
  console.log(`App Server/schema: ${report.codex.appServer ? "available" : "unavailable"}/${report.codex.schemaGeneration ? "valid" : "failed"}`)
  console.log(`Hooks: feature=${String(report.hooks.featureEnabled)} installed=${report.hooks.installed} trusted=review in /hooks`)
  console.log(`Ports: 4174=${report.ports.protocol4174} 4175=${report.ports.hook4175}`)
  console.log(`Attach: ${report.attach?.status ?? "not checked"} (enabled=${report.attach?.backendEnabled ?? false})`)
  for (const warning of [...report.permissions.warnings, ...report.warnings]) console.log(`Warning: ${warning}`)
}
