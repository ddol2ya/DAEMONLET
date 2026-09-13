#!/usr/bin/env node
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { manageHooks } from "../adapter/codex/hooks/HookInstaller.ts"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const args = new Set(process.argv.slice(2))
const action = args.has("--apply") ? "apply" : args.has("--status") ? "status" : args.has("--uninstall") ? "uninstall" : "dry-run"
const codexHome = resolve(process.env.CODEX_HOME ?? join(homedir(), ".codex"))

try {
  const result = await manageHooks({ action, codexHome, projectRoot: root })
  if (action === "status") {
    console.log(JSON.stringify({ path: result.path, installed: result.installed, configurationStatus: result.configurationStatus }, null, 2))
  } else {
    console.log(JSON.stringify({
      mode: "development-node", path: result.path, action, changed: result.changed,
      applied: action !== "dry-run", changes: result.changes,
      foreignHandlersPreserved: result.foreignHandlersPreserved,
      generatedCommand: action === "uninstall" ? null : result.generatedCommand,
      backupPath: result.backupPath ?? null,
    }, null, 2))
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
