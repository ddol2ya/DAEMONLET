#!/usr/bin/env node
import { createCodexAdapterConfig } from "../adapter/codex/CodexAdapterConfig.ts"
import { CodexAdapterService } from "../adapter/codex/CodexAdapterService.ts"

const args = process.argv.slice(2)
const modeArg = args[args.indexOf("--mode") + 1] ?? "hooks"
const mode = modeArg === "hooks" ? "HOOK_OBSERVER" : modeArg === "app-server-owned" ? "APP_SERVER_OWNED" : modeArg === "app-server-attach" ? "APP_SERVER_ATTACH" : null
if (!mode) throw new Error(`unknown adapter mode: ${modeArg}`)

const config = createCodexAdapterConfig({ mode })
const service = new CodexAdapterService(config)
await service.start()
console.log(JSON.stringify({ ready: true, mode, protocol: `ws://${config.protocolHost}:${config.protocolPort}/events`, hookIngress: mode === "HOOK_OBSERVER" ? `http://${config.hookHost}:${config.hookPort}/hook` : null }, null, 2))

let stopping = false
const stop = async () => {
  if (stopping) return
  stopping = true
  await service.stop()
  process.exitCode = 0
}
process.once("SIGINT", () => { void stop().then(() => process.exit(0)) })
process.once("SIGTERM", () => { void stop().then(() => process.exit(0)) })
