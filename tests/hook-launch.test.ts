import { createServer, type Server } from "node:http"
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as fuses from "@electron/fuses"
import { createHookCommand, DISCARDED_HOOK_ENVIRONMENT, HOOK_ARGUMENT, HOOK_SYSTEM_PATH, inspectHookHost, isTemporaryInstallPath, quotePosix, type HookLaunchSpec } from "../adapter/codex/hooks/HookLaunchSpec.ts"
import { runHookCommand, runHookHostSelfTest } from "../adapter/codex/hooks/HookHostSelfTest.ts"

vi.mock("@electron/fuses", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@electron/fuses")>()
  return { ...actual, getCurrentFuseWire: vi.fn(actual.getCurrentFuseWire) }
})

const directories: string[] = [], servers: Server[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()) }))); await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })
const packageSpec: HookLaunchSpec = { mode: "packaged-electron-node", executablePath: "/Applications/Pet.app/Contents/MacOS/Pet", forwarderPath: "/Applications/Pet.app/Contents/Resources/codex/hook-forwarder.mjs", dataDir: "/Users/test/.pet", hookEndpoint: "http://127.0.0.1:4175/hook" }
async function fixture(forcePrivateHost = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pet-경로 ' $(not-a-command) `not-a-command` -")))
  directories.push(root)
  const dataDir = join(root, "data ' $() `literal`"), forwarderPath = join(root, "forwarder ' $() `literal`.mjs")
  await mkdir(dataDir, { mode: 0o700 })
  // CI toolcache executables and checkout files may be group-writable. The
  // host policy correctly rejects those; create private test-owned copies
  // instead of weakening inspection or chmodding the runner's shared Node.
  const runnerNode = await realpath(process.execPath)
  const needsPrivateHost = forcePrivateHost || ((await lstat(runnerNode)).mode & 0o022) !== 0
  const executablePath = needsPrivateHost ? join(root, "private-test-node") : runnerNode
  if (needsPrivateHost) {
    await copyFile(runnerNode, executablePath)
    await chmod(executablePath, 0o700)
  }
  await copyFile(resolve("adapter/codex/hooks/hook-forwarder.mjs"), forwarderPath)
  await chmod(forwarderPath, 0o600)
  await writeFile(join(dataDir, "adapter-token"), "PRIVATE_TOKEN_CANARY", { mode: 0o600 })
  const spec: HookLaunchSpec = { mode: "development-node", executablePath, forwarderPath, dataDir, hookEndpoint: "http://127.0.0.1:4175/hook" }
  return { root, spec }
}

describe("Hook command factory and runtime boundaries", () => {
  it("uses an absolute system launcher, explicit runtime paths/data/endpoint, and no token or stdin argument", () => {
    const command = createHookCommand(packageSpec)
    expect(command.startsWith("/usr/bin/env -i ")).toBe(true)
    expect(command).toContain("'ELECTRON_RUN_AS_NODE=1'")
    expect(command).toContain("'CODEX_PET_DATA_DIR=/Users/test/.pet'")
    expect(command).toContain("'CODEX_PET_HOOK_URL=http://127.0.0.1:4175/hook'")
    expect(command).toContain(quotePosix(HOOK_ARGUMENT))
    expect(command).not.toMatch(/Cellar|env node|curl|adapter-token|PRIVATE_TOKEN|session_id|prompt/)
    expect(createHookCommand({ ...packageSpec, mode: "development-node", executablePath: "/usr/local/bin/node" })).not.toContain("ELECTRON_RUN_AS_NODE")
  })
  it.each(["bad\0path", "bad\npath", "bad\rpath"])("rejects unsafe control characters in %s", (path) => {
    expect(() => quotePosix(path)).toThrow("INVALID_LAUNCH_VALUE")
    expect(() => createHookCommand({ ...packageSpec, dataDir: `/${path}` })).toThrow("INVALID_LAUNCH_PATH")
  })
  it("rejects wrong package layouts and non-loopback endpoints, and detects temporary locations without hardcoding Applications", () => {
    expect(() => createHookCommand({ ...packageSpec, forwarderPath: "/project/adapter/codex/hooks/hook-forwarder.mjs" })).toThrow("INVALID_PACKAGE_LAYOUT")
    expect(() => createHookCommand({ ...packageSpec, hookEndpoint: "http://example.com/hook" })).toThrow("INVALID_HOOK_ENDPOINT")
    for (const path of ["/tmp/Pet.app", "/private/var/folders/user/AppTranslocation/Pet.app", "/Users/test/Downloads/Pet.app", "/Users/test/project/work/Pet.app", "/repo/out/Pet.app"]) expect(isTemporaryInstallPath(path)).toBe(true)
    for (const path of ["/Applications/Pet.app", "/Users/test/Applications/Pet.app", "/Users/test/My Apps/Pet.app"]) expect(isTemporaryInstallPath(path)).toBe(false)
  })
  it.runIf(process.platform !== "win32")("[POSIX host] passes Unicode, quotes, substitution and backtick paths literally and strips inherited startup environment", async () => {
    const f = await fixture()
    const report = join(f.spec.dataDir, "environment.json")
    await writeFile(f.spec.forwarderPath, 'import {writeFileSync} from "node:fs"; import {join} from "node:path"; writeFileSync(join(process.env.CODEX_PET_DATA_DIR,"environment.json"), JSON.stringify({env:process.env,args:process.argv.slice(1)})); process.stdout.write("{}\\n");\n')
    const environment: NodeJS.ProcessEnv = { PATH: "/missing", ...Object.fromEntries(DISCARDED_HOOK_ENVIRONMENT.filter((key) => !key.startsWith("DYLD") && !key.startsWith("LD_")).map((key) => [key, "PRIVATE_INHERITED_CANARY"])) }
    environment.NODE_OPTIONS = "--require /missing/preload.cjs"
    const result = await runHookCommand(f.spec, "{}", { environment })
    expect(result).toMatchObject({ outputContract: true, timedOut: false, cleanedUp: true })
    const observed = JSON.parse(await readFile(report, "utf8"))
    expect(observed.args).toEqual([f.spec.forwarderPath, HOOK_ARGUMENT])
    // CoreFoundation may insert this OS-owned encoding hint after env -i.
    const { __CF_USER_TEXT_ENCODING: _nativeEncoding, ...environmentAfterLaunch } = observed.env
    expect(environmentAfterLaunch).toEqual({ PATH: HOOK_SYSTEM_PATH, CODEX_PET_DATA_DIR: f.spec.dataDir, CODEX_PET_HOOK_URL: f.spec.hookEndpoint, CODEX_PET_HOOK_TIMEOUT_MS: "250" })
    expect(JSON.stringify(observed)).not.toContain("PRIVATE_INHERITED_CANARY")
  })
  it.runIf(process.platform !== "win32")("[POSIX host] bounds never-ended stdin, excess body and malformed input without leaking output", async () => {
    const f = await fixture()
    for (const [input, holdStdin] of [["{", false], ["x".repeat(65537), false], ["{}", true]] as const) {
      const result = await runHookCommand(f.spec, input, { holdStdin })
      expect(result).toMatchObject({ outputContract: true, timedOut: false, cleanedUp: true })
      expect(result.wallTimeMs).toBeLessThan(1000)
    }
  })
  it.runIf(process.platform !== "win32")("[POSIX host] verifies actual sanitized receipt separately from stdout and handles cancellation", async () => {
    const f = await fixture()
    const result = await runHookHostSelfTest(f.spec)
    expect(result).toMatchObject({ status: "passed", source: "unit", receiverVerified: true, sanitized: true, cleanedUp: true })
    expect(result.cases.find((item) => item.name === "adapter-offline-no-autostart")?.passed).toBe(true)
    const abort = new AbortController()
    const child = runHookCommand(f.spec, "{}", { holdStdin: true, signal: abort.signal })
    abort.abort()
    expect(await child).toMatchObject({ timedOut: true, cleanedUp: true })
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|"sessionId":|"turnId":|"token":|"prompt":/)
  })
  it.runIf(process.platform !== "win32")("[POSIX host] reports OS-level host unavailability separately from the forwarder's exit-zero contract", async () => {
    const f = await fixture()
    const missing = { ...f.spec, executablePath: join(f.root, "does-not-exist") }
    expect(await inspectHookHost(missing)).toMatchObject({ available: false, reason: "host-unavailable" })
    expect(await runHookCommand(missing, "{}")).toMatchObject({ hostStarted: false, outputContract: false })
    expect(await runHookHostSelfTest(missing)).toMatchObject({ status: "host-unavailable", receiverVerified: false })
  })
  it.runIf(process.platform !== "win32")("[POSIX host] refuses group-writable runtime or resource files while accepting private test-owned copies", async () => {
    const f = await fixture(true)
    expect(await inspectHookHost(f.spec)).toMatchObject({ available: true })
    for (const [path, mode] of [[f.spec.executablePath, 0o700], [f.spec.forwarderPath, 0o600]] as const) {
      await chmod(path, mode | 0o020)
      expect(await inspectHookHost(f.spec)).toMatchObject({ available: false, reason: "host-unavailable" })
      await chmod(path, mode)
    }
    expect(await inspectHookHost(f.spec)).toMatchObject({ available: true })
  })
  it.runIf(process.platform !== "win32")("[POSIX host] never treats stdout alone as successful delivery", async () => {
    const f = await fixture()
    await writeFile(f.spec.forwarderPath, 'process.stdout.write("{}\\n");\n')
    const value = await runHookHostSelfTest(f.spec)
    expect(value).toMatchObject({ status: "failed", receiverVerified: false, cleanedUp: true })
  })
  it.runIf(process.platform === "darwin")("refuses a disabled RunAsNode fuse before launching any process", async () => {
    const f = await fixture()
    const executablePath = join(f.root, "Pet.app/Contents/MacOS/Pet"), forwarderPath = join(f.root, "Pet.app/Contents/Resources/codex/hook-forwarder.mjs")
    await mkdir(join(f.root, "Pet.app/Contents/MacOS"), { recursive: true })
    await mkdir(join(f.root, "Pet.app/Contents/Resources/codex"), { recursive: true })
    await writeFile(executablePath, "#!/bin/sh\nexit 99\n", { mode: 0o700 })
    await copyFile(f.spec.forwarderPath, forwarderPath)
    vi.mocked(fuses.getCurrentFuseWire).mockResolvedValueOnce({ version: fuses.FuseVersion.V1, [fuses.FuseV1Options.RunAsNode]: fuses.FuseState.DISABLE })
    const value = await inspectHookHost({ ...f.spec, mode: "packaged-electron-node", executablePath, forwarderPath })
    expect(value).toMatchObject({ available: false, runAsNode: "disabled", reason: "run-as-node-disabled" })
  })
})
