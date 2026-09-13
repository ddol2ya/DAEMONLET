import { mkdir, realpath, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { APP_NAME } from "../electron/shared/app-identity.mjs"
import { inspectHookHost, type HookLaunchSpec } from "../adapter/codex/hooks/HookLaunchSpec.ts"
import { runHookHostSelfTest } from "../adapter/codex/hooks/HookHostSelfTest.ts"

const root = resolve(import.meta.dirname, "..")
const args = process.argv.slice(2)
let requestedBundle: string | undefined
let requestedOutput: string | undefined
while (args.length) {
  const argument = args.shift()!
  if (argument === "--output" && requestedOutput === undefined && args[0] && !args[0].startsWith("--")) requestedOutput = args.shift()
  else if (!argument.startsWith("--") && requestedBundle === undefined) requestedBundle = argument
  else throw new Error("Usage: setup:host-proof [bundle.app] [--output evidence.json]")
}
const outputPath = requestedOutput ? resolve(requestedOutput) : join(root, "docs/evidence/packaged-hook-setup/host-selftest.json")
const bundle = await realpath(requestedBundle ?? join(root, `out/${APP_NAME}-darwin-${process.arch}/${APP_NAME}.app`))
const spec: HookLaunchSpec = {
  mode: "packaged-electron-node",
  executablePath: join(bundle, "Contents/MacOS", basename(bundle, ".app")),
  forwarderPath: join(bundle, "Contents/Resources/codex/hook-forwarder.mjs"),
  // Only the inspection uses these placeholder roles; the test substitutes its
  // own fresh private directory and ephemeral receiver. Never a real adapter.
  dataDir: "/private/tmp/unused-selftest-role", hookEndpoint: "http://127.0.0.1:4175/hook",
}
const inspection = await inspectHookHost(spec)
const result = await runHookHostSelfTest(spec)
const evidence = { recordedAt: new Date().toISOString(), source: "synthetic-packaged", inspection, result, externalNodeUsed: false, path: "/usr/bin:/bin:/usr/sbin:/sbin", actualCodexHook: "not-tested", actualDesktopStop: "not-tested" }
await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`)
console.log(JSON.stringify(evidence, null, 2))
if (result.status !== "passed") process.exitCode = 1
