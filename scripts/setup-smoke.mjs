import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:net"
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { runHookHostSelfTest } from "../adapter/codex/hooks/HookHostSelfTest.ts"
import { createHookCommand, HOOK_SYSTEM_PATH } from "../adapter/codex/hooks/HookLaunchSpec.ts"

const project = resolve(import.meta.dirname, "..")
if (process.platform !== "darwin") throw new Error("setup:smoke requires macOS; unit tests and both builds remain cross-platform")
const evidence = resolve(process.env.SETUP_SMOKE_EVIDENCE_DIRECTORY ?? join(project, "outputs/evidence/packaged-hook-setup"))
await mkdir(evidence, { recursive: true })

const runNode = (file, args = []) => new Promise((done, reject) => {
  const child = spawn(process.execPath, [file, ...args], { cwd: project, env: process.env, stdio: "inherit" })
  child.once("error", reject)
  child.once("close", (code) => code === 0 ? done() : reject(new Error("SETUP_SMOKE_BUILD_FAILED")))
})
const freePort = () => new Promise((done, reject) => {
  const server = createServer()
  server.once("error", reject)
  server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close((error) => error ? reject(error) : done(port)) })
})
const released = (port) => new Promise((done) => {
  const server = createServer()
  server.once("error", () => done(false))
  server.listen(port, "127.0.0.1", () => server.close((error) => done(!error)))
})
const gone = (pid) => { try { process.kill(pid, 0); return false } catch (error) { return error.code === "ESRCH" } }
const waitFor = async (predicate, timeout = 10000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await predicate()) return true; await new Promise((done) => setTimeout(done, 100)) }
  return false
}

await runNode(join(project, "scripts/build-renderer.mjs"))
await runNode(join(project, "electron/build/build-electron.mjs"), ["--production", "--setup-smoke"])
const forgePackage = JSON.parse(await readFile(join(project, "node_modules/@electron-forge/cli/package.json"), "utf8"))
const forgeBin = typeof forgePackage.bin === "string" ? forgePackage.bin : forgePackage.bin["electron-forge"]
await runNode(join(project, "node_modules/@electron-forge/cli", forgeBin), ["package"])

const root = await realpath(await mkdtemp("/private/tmp/daemonlet-setup-smoke-"))
const home = join(root, "codex-home"), userData = join(root, "userData"), dataDir = join(root, "adapter-data"), standalone = join(root, "standalone")
await Promise.all([home, userData, dataDir, standalone, join(root, "bin")].map((path) => mkdir(path, { mode: 0o700 })))
const sourceBundle = join(project, `out/Daemonlet for Codex-darwin-${process.arch}/Daemonlet for Codex.app`)
const bundle = join(standalone, "Pet 한글 ' $() `literal`.app")
// Preserve relative framework symlinks. Resolving them into the build tree
// would make a copied package appear independent while still using that tree.
await cp(sourceBundle, bundle, { recursive: true, verbatimSymlinks: true })
const executable = join(bundle, "Contents/MacOS/Daemonlet for Codex")
const fakeCodex = join(root, "bin/codex")
await writeFile(fakeCodex, "#!/bin/sh\nif [ \"$1\" = '--version' ]; then printf 'codex-cli 0.147.0\\n'; elif [ \"$1\" = 'features' ] && [ \"$2\" = 'list' ]; then printf 'hooks stable true\\n'; else exit 1; fi\n", { mode: 0o700 })
await writeFile(join(home, "config.toml"), "# isolated setup smoke\n[features]\nhooks = true\n", { mode: 0o600 })
await writeFile(join(home, "hooks.json"), JSON.stringify({ description: "PRIVATE_DESCRIPTION_CANARY", hooks: { Stop: [{ description: "PRIVATE_GROUP_CANARY", hooks: [{ type: "command", command: "PRIVATE_FOREIGN_A_CANARY" }, { type: "command", command: "PRIVATE_FOREIGN_B_CANARY", statusMessage: "daemonlet-codex-pet-adapter" }] }] }, metadata: { preserved: true } }), { mode: 0o600 })
const protocolPort = await freePort()
let hookPort
do { hookPort = await freePort() } while (hookPort === protocolPort)
const spec = { mode: "packaged-electron-node", executablePath: executable, forwarderPath: join(bundle, "Contents/Resources/codex/hook-forwarder.mjs"), dataDir, hookEndpoint: `http://127.0.0.1:${hookPort}/hook` }
const report = { source: "synthetic-packaged", status: "failed", recordedAt: new Date().toISOString(), build: "explicit-setup-smoke-build", actualCodexHook: "not-tested", actualDesktopStop: "not-tested", actualUserSettingsModified: false, actualInstalledAppModified: false, sourceCodeAvailableAtExecutionLocation: false, externalNodeUsedByHook: false, limitedPath: HOOK_SYSTEM_PATH, passes: [], cleanup: {} }
let activeChild = null
const rawLogs = []
const phase = async (pass) => {
  const child = spawn(executable, [], { cwd: standalone, detached: true, stdio: ["ignore", "pipe", "pipe"], env: {
    PATH: HOOK_SYSTEM_PATH, ELECTRON_SMOKE_USER_DATA: userData, ELECTRON_SMOKE_ADAPTER_MODE: "owned",
    CODEX_HOME: home, CODEX_PATH: fakeCodex, CODEX_PET_DATA_DIR: dataDir,
    CODEX_PET_PROTOCOL_PORT: String(protocolPort), CODEX_PET_HOOK_PORT: String(hookPort),
    SETUP_SMOKE_ROOT: root, SETUP_SMOKE_EVIDENCE_DIR: join(evidence, "screenshots"), SETUP_SMOKE_PASS: pass,
    SETUP_SMOKE_LEGACY_NODE_PATH: process.execPath,
  } })
  activeChild = child
  child.stdout.on("data", (chunk) => { rawLogs.push(chunk.toString().slice(0, 4096)); if (rawLogs.length > 100) rawLogs.shift() })
  child.stderr.on("data", (chunk) => { rawLogs.push(chunk.toString().slice(0, 4096)); if (rawLogs.length > 100) rawLogs.shift() })
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, "SIGKILL") } catch {} }, 150000)
  const code = await new Promise((done, reject) => { child.once("error", reject); child.once("close", done) })
  clearTimeout(timer)
  activeChild = null
  assert(!timedOut && code === 0, "SMOKE_APP_LIFETIME_FAILED")
  const value = JSON.parse(await readFile(join(root, `${pass}-result.json`), "utf8"))
  const pids = JSON.parse(await readFile(join(root, `${pass}-processes.json`), "utf8"))
  value.childProcessesExited = await waitFor(() => pids.every(gone))
  value.portsReleased = await released(protocolPort) && await released(hookPort)
  report.passes.push(value)
  assert(value.status === "passed", value.failure ?? "SMOKE_APP_CHECK_FAILED")
  assert(value.childProcessesExited && value.portsReleased, "SMOKE_APP_CLEANUP_FAILED")
  const { command } = JSON.parse(await readFile(join(root, "installed-command.json"), "utf8"))
  assert.equal(command, createHookCommand(spec), "SMOKE_OFFLINE_FACTORY_MATCH")
  const started = performance.now()
  const offline = spawn("/bin/sh", ["-c", command], { cwd: standalone, env: { PATH: HOOK_SYSTEM_PATH }, stdio: ["pipe", "pipe", "pipe"] })
  let stdout = "", stderr = ""
  offline.stdout.on("data", (chunk) => { stdout += chunk.toString() })
  offline.stderr.on("data", (chunk) => { stderr += chunk.toString() })
  offline.stdin.on("error", () => {})
  const watchdog = setTimeout(() => offline.kill("SIGKILL"), 2000)
  offline.stdin.end(JSON.stringify({ session_id: "synthetic-offline", cwd: "/synthetic", model: "synthetic", turn_id: "synthetic", hook_event_name: "UserPromptSubmit", prompt: "PRIVATE_OFFLINE_CANARY" }))
  const exitCode = await new Promise((done) => offline.once("close", done))
  clearTimeout(watchdog)
  value.offlineHook = { status: exitCode === 0 && stdout === "{}\n" && stderr === "" ? "passed" : "failed", wallTimeMs: Math.round(performance.now() - started), portsStillReleased: await released(protocolPort) && await released(hookPort), priorAppProcessesStillExited: pids.every(gone) }
  assert(value.offlineHook.status === "passed" && value.offlineHook.portsStillReleased && value.offlineHook.priorAppProcessesStillExited, "SMOKE_OFFLINE_HOOK_FAILED")
}

try {
  // First invocation at this independent location happens before any GUI launch.
  report.hostBeforeGui = await runHookHostSelfTest(spec)
  assert.equal(report.hostBeforeGui.status, "passed", "SMOKE_HOST_BEFORE_GUI_FAILED")
  await phase("fresh")
  await phase("relaunch")
  assert(!rawLogs.join("").includes("PRIVATE_"), "SMOKE_PRIVATE_PROCESS_OUTPUT")
  report.status = "passed"
} catch (error) {
  report.failure = error instanceof Error ? error.message.split("\n")[0].replaceAll(root, "<isolated-smoke>") : "SMOKE_FAILED"
  process.exitCode = 1
} finally {
  if (activeChild?.pid) { try { process.kill(-activeChild.pid, "SIGKILL") } catch {} }
  report.cleanup = { protocolPortReleased: await released(protocolPort), hookPortReleased: await released(hookPort) }
  // Failure logs remain local and ignored; the committed report contains only
  // allowlisted facts and fixed failure codes, never arbitrary process output.
  await mkdir(join(project, "outputs/packaged-setup"), { recursive: true })
  await writeFile(join(project, "outputs/packaged-setup/setup-smoke-process.log"), rawLogs.join(""), { mode: 0o600 })
  await writeFile(join(evidence, "packaged-smoke.json"), `${JSON.stringify(report, null, 2)}\n`)
  await rm(root, { recursive: true, force: true })
  console.log(JSON.stringify({ source: report.source, status: report.status, failure: report.failure ?? null, passes: report.passes.map((value) => ({ pass: value.pass, status: value.status, failure: value.failure ?? null })), cleanup: report.cleanup }))
  // Restore a regular production build and package after the test-only run.
  await runNode(join(project, "electron/build/build-electron.mjs"), ["--production"])
  const productionMain = await readFile(join(project, "dist-electron/main.cjs"), "utf8")
  assert(!productionMain.includes("SETUP_SMOKE_ROOT"), "SMOKE_CODE_REMOVED_FROM_PRODUCTION")
  await runNode(join(project, "node_modules/@electron-forge/cli", forgeBin), ["package"])
}
