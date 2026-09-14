import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { HookSetupDoctor, parseHookFeatureOutput } from "../adapter/codex/doctor/HookSetupDoctor.ts"
import { hookContractFor, type HookSupportContract } from "../adapter/codex/doctor/HookSupportContract.ts"
import { allEventSupport } from "../adapter/codex/hooks/HookInstallPlan.ts"
import { hashFile, HOOK_MARKER, quotePosix } from "../adapter/codex/hooks/HookLaunchSpec.ts"

const directories: string[] = [], doctors: HookSetupDoctor[] = []
afterEach(async () => { for (const doctor of doctors.splice(0)) doctor.dispose(); await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })
const missing = async (path: string) => { try { await access(path); return false } catch { return true } }
async function fixture(featureLine = "hooks stable true", version = "codex-cli 9.0.0", extra = "") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pet-doctor-")))
  directories.push(root)
  const home = join(root, "home"), bin = join(root, "bin"), calls = join(root, "calls"), executable = join(bin, "codex"), policy = join(root, "requirements.toml")
  await mkdir(home, { mode: 0o700 }); await mkdir(bin)
  await writeFile(executable, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${quotePosix(calls)}\n${extra}\nif [ "$1" = '--version' ]; then printf '%s\\n' ${quotePosix(version)}; else printf '%s\\n' ${quotePosix(featureLine)}; fi\n`, { mode: 0o700 })
  const contract: HookSupportContract = { id: "synthetic-contract", version, artifactSha256: await hashFile(executable), surface: "synthetic", source: "test-fixture", events: allEventSupport("supported"), featureKey: "hooks", eventTimeoutSeconds: 2 }
  const make = (extraOptions: ConstructorParameters<typeof HookSetupDoctor>[0] = {}) => {
    const doctor = new HookSetupDoctor({ defaultHome: home, environment: { PATH: bin }, policyPath: policy, contracts: [contract], ...extraOptions })
    doctors.push(doctor)
    return doctor
  }
  return { root, home, bin, calls, executable, policy, contract, make, selection: { executablePath: null, codexHome: null } }
}

describe("bounded read-only Hook setup discovery", () => {
  it("distinguishes absent features from explicit false and recognizes the legacy alias", () => {
    expect(parseHookFeatureOutput("other stable false")).toBe("unknown")
    expect(parseHookFeatureOutput("hooks stable false")).toBe("disabled")
    expect(parseHookFeatureOutput("codex_hooks under development true")).toBe("enabled")
    expect(parseHookFeatureOutput("codex_hooks stable false\nhooks stable true")).toBe("enabled")
  })
  it("requires the exact artifact and version, never semver extrapolation", async () => {
    const f = await fixture()
    expect(hookContractFor(f.contract.artifactSha256, f.contract.version, [f.contract])?.id).toBe("synthetic-contract")
    expect(hookContractFor(f.contract.artifactSha256, "codex-cli 9.0.1", [f.contract])).toBeNull()
    expect(hookContractFor("other-artifact", f.contract.version, [f.contract])).toBeNull()
  })
  it.runIf(process.platform !== "win32")("[POSIX CLI/config] uses selected Home before environment and default, and only probes fixed read-only commands", async () => {
    const f = await fixture(), selected = join(f.root, "selected"), override = join(f.root, "override")
    await mkdir(selected); await mkdir(override)
    const doctor = f.make({ environment: { PATH: f.bin, CODEX_HOME: override } })
    expect((await doctor.inspect({ ...f.selection, codexHome: selected })).home).toEqual({ path: selected, source: "selected" })
    expect((await doctor.inspect(f.selection)).home).toEqual({ path: override, source: "environment" })
    expect((await f.make().inspect(f.selection)).home).toEqual({ path: f.home, source: "default" })
    expect(new Set((await readFile(f.calls, "utf8")).trim().split("\n"))).toEqual(new Set(["--version", "features list"]))
  })
  it("leaves Desktop-only/missing CLI capability unknown and does not create a home", async () => {
    const f = await fixture(), home = join(f.root, "not-created")
    const value = await f.make({ environment: { PATH: "" }, defaultHome: home }).inspect(f.selection)
    expect(value.executable.probeStatus).toBe("missing")
    expect(value.capability.events).toEqual(allEventSupport("unknown"))
    expect(value.warnings).toContain("CLI_NOT_FOUND_DESKTOP_MAY_STILL_WORK")
    expect(await missing(home)).toBe(true)
  })
  it.runIf(process.platform !== "win32")("[POSIX CLI/config] does not execute an unrecognized PATH or CODEX_PATH candidate until explicitly selected", async () => {
    const f = await fixture()
    const doctor = f.make({ contracts: [], environment: { CODEX_PATH: f.executable, PATH: f.bin } })
    expect((await doctor.inspect(f.selection)).executable.probeStatus).toBe("selection-required")
    expect(await missing(f.calls)).toBe(true)
    const selected = await doctor.inspect({ ...f.selection, executablePath: f.executable })
    expect(selected.executable.version).toBe("codex-cli 9.0.0")
    expect(selected.capability.contractId).toBeNull()
    expect((await readFile(f.calls, "utf8")).trim()).toBe("--version")
  })
  it.runIf(process.platform !== "win32")("[POSIX CLI/config] finds a verified installation without the interactive shell PATH", async () => {
    const f = await fixture()
    const doctor = f.make({ environment: { PATH: '/usr/bin:/bin' }, additionalExecutables: async () => [f.executable] })
    expect((await doctor.inspect(f.selection)).executable).toMatchObject({ path: f.executable, source: 'installation', probeStatus: 'verified' })
    expect(new Set((await readFile(f.calls, 'utf8')).trim().split('\n'))).toEqual(new Set(['--version', 'features list']))
  })
  it.runIf(process.platform !== "win32")("[POSIX CLI/config] does not let an unknown PATH shim hide another verified installation", async () => {
    const f = await fixture(), shimBin = join(f.root, 'shim-bin'), canary = join(f.root, 'unexpected-execution')
    await mkdir(shimBin)
    await writeFile(join(shimBin, 'codex'), `#!/bin/sh\ntouch ${quotePosix(canary)}\n`, { mode: 0o700 })
    const doctor = f.make({ environment: { PATH: shimBin }, additionalExecutables: async () => [f.executable] })
    expect((await doctor.inspect(f.selection)).executable.path).toBe(f.executable)
    expect(await missing(canary)).toBe(true)
    expect((await doctor.inspect({ ...f.selection, executablePath: join(shimBin, 'codex') })).executable.probeStatus).toBe('failed')
  })
  it.runIf(process.platform !== "win32")("[POSIX CLI/config] does not execute an unknown discovered installation or fall back from an explicit unavailable selection", async () => {
    const f = await fixture()
    const doctor = f.make({ environment: { PATH: '' }, contracts: [], additionalExecutables: async () => [f.executable] })
    expect((await doctor.inspect(f.selection)).executable.probeStatus).toBe('selection-required')
    expect(await missing(f.calls)).toBe(true)
    expect((await doctor.inspect({ ...f.selection, executablePath: join(f.root, 'missing') })).executable.path).toBeNull()
    expect(await missing(f.calls)).toBe(true)
  })
  it.runIf(process.platform !== "win32")("[POSIX CLI/config] coalesces requests, caches read-only probes, and invalidates cache on config and artifact changes", async () => {
    const f = await fixture(), doctor = f.make()
    await Promise.all([doctor.inspect(f.selection), doctor.inspect(f.selection), doctor.inspect(f.selection)])
    await doctor.inspect(f.selection)
    expect((await readFile(f.calls, "utf8")).trim().split("\n")).toHaveLength(2)
    await writeFile(join(f.home, "config.toml"), `[hooks]\ndescription = '${HOOK_MARKER}'\n`, { mode: 0o600 })
    expect((await doctor.inspect(f.selection)).inlineOwnedConflict).toBe(true)
    expect((await readFile(f.calls, "utf8")).trim().split("\n")).toHaveLength(4)
    await writeFile(f.executable, "#!/bin/sh\nprintf 'codex-cli 10.0.0'\n", { mode: 0o700 })
    expect((await doctor.inspect(f.selection)).capability.contractId).toBeNull()
  })
  it.runIf(process.platform !== "win32")("[POSIX CLI/config] reads quoted TOML inline hooks and managed policy without modifying either file", async () => {
    const f = await fixture("hooks stable false")
    const config = `['hooks'.'Stop']\ndescription = '${HOOK_MARKER} PRIVATE_CONFIG_CANARY'\n`
    const policy = "allow_managed_hooks_only = true\n[features]\nhooks = true\n"
    await writeFile(join(f.home, "config.toml"), config, { mode: 0o600 })
    await writeFile(f.policy, policy, { mode: 0o600 })
    const value = await f.make().inspect(f.selection)
    expect(value).toMatchObject({ feature: "disabled", policy: "blocked", inlineOwnedConflict: true, manualFeatureInstruction: "[features]\nhooks = true" })
    expect(JSON.stringify(value)).not.toContain("PRIVATE_CONFIG_CANARY")
    expect(await readFile(join(f.home, "config.toml"), "utf8")).toBe(config)
    expect(await readFile(f.policy, "utf8")).toBe(policy)
    expect(value.uninspectedScope).toContain("hook-trust-store")
  })
  it.runIf(process.platform !== "win32")("[POSIX CLI/config] keeps absent feature status unknown and treats an invalid configuration as a separate issue", async () => {
    const f = await fixture("another_feature stable true")
    expect((await f.make().inspect(f.selection)).feature).toBe("unknown")
    await writeFile(join(f.home, "config.toml"), "[bad\nPRIVATE_CANARY", { mode: 0o600 })
    const value = await f.make().inspect(f.selection)
    expect(value.warnings).toContain("CONFIG_UNREADABLE_OR_INVALID")
    expect(JSON.stringify(value)).not.toContain("PRIVATE_CANARY")
  })
  it.runIf(process.platform !== "win32")("[POSIX CLI/config] does not use a user-file true flag as effective feature proof after the verified CLI rejects its config", async () => {
    const f = await fixture("", "codex-cli 9.0.0", 'if [ "$1" = "features" ]; then printf "PRIVATE_CONFIG_ERROR_CANARY" >&2; exit 1; fi')
    const config = "[features]\nhooks = true\n[features.context_management]\nexperimental_mode = true\n"
    await writeFile(join(f.home, "config.toml"), config, { mode: 0o600 })
    const value = await f.make().inspect(f.selection)
    expect(value.executable).toMatchObject({ version: f.contract.version, probeStatus: "failed" })
    expect(value.capability.contractId).toBe(f.contract.id)
    expect(value.feature).toBe("unknown")
    expect(value.manualFeatureInstruction).toBeNull()
    expect(value.warnings).toContain("CODEX_PROBE_FAILED")
    expect(JSON.stringify(value)).not.toContain("PRIVATE_CONFIG_ERROR_CANARY")
    expect(await readFile(join(f.home, "config.toml"), "utf8")).toBe(config)
  })
  it.runIf(process.platform !== "win32")("[POSIX CLI/config] preserves a supported structured context-management setting when the matched CLI reports hooks enabled", async () => {
    const f = await fixture("hooks stable true")
    const config = "[features]\nhooks = true\n[features.context_management]\nexperimental_mode = true\n"
    await writeFile(join(f.home, "config.toml"), config, { mode: 0o600 })
    const value = await f.make().inspect(f.selection)
    expect(value).toMatchObject({ feature: "enabled", executable: { probeStatus: "verified" }, manualFeatureInstruction: null, warnings: [] })
    expect(await readFile(join(f.home, "config.toml"), "utf8")).toBe(config)
  })
  it.runIf(process.platform !== "win32")("[POSIX CLI/config] bounds timed-out and oversized probes, suppresses arbitrary output, and cancels pending work", async () => {
    const slow = await fixture("hooks stable true", "codex-cli 9.0.0", "/bin/sleep 10")
    const started = Date.now()
    const value = await slow.make({ probeTimeoutMs: 60 }).inspect(slow.selection)
    expect(value.executable.probeStatus).toBe("failed")
    expect(Date.now() - started).toBeLessThan(1500)
    const noisy = await fixture("hooks stable true", "codex-cli 9.0.0", "printf 'PRIVATE_STDERR_CANARY' >&2; exit 1")
    expect(JSON.stringify(await noisy.make().inspect(noisy.selection))).not.toContain("PRIVATE_STDERR_CANARY")
    const oversized = await fixture("hooks stable true", "codex-cli 9.0.0", "/usr/bin/yes PRIVATE_OVERSIZE_CANARY")
    const rejectedOutput = await oversized.make().inspect(oversized.selection)
    expect(rejectedOutput.executable.probeStatus).toBe("failed")
    expect(JSON.stringify(rejectedOutput)).not.toContain("PRIVATE_OVERSIZE_CANARY")
    const doctor = slow.make()
    const pending = doctor.inspect(slow.selection)
    await new Promise((done) => setTimeout(done, 30))
    doctor.dispose()
    await expect(pending).rejects.toThrow("PROBE_CANCELLED")
  })
  it("rejects invalid selected homes and inaccessible executables without broad searching", async () => {
    const f = await fixture()
    await expect(f.make().inspect({ ...f.selection, codexHome: join(f.home, "missing", "nested") })).rejects.toThrow()
    await chmod(f.executable, 0o600)
    const value = await f.make().inspect({ ...f.selection, executablePath: f.executable })
    expect(value.warnings).toContain("SELECTED_CODEX_UNAVAILABLE")
    expect(await missing(f.calls)).toBe(true)
  })
})
