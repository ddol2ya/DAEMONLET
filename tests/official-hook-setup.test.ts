import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdir, mkdtemp, realpath, rm, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import schemas from "../adapter/codex/doctor/HookWireSchemas.json"
import { HookSetupDoctor } from "../adapter/codex/doctor/HookSetupDoctor"
import { assertCompatibleHookInput, officialHookContract } from "../adapter/codex/doctor/OfficialHookContract"
import { CodexIntegrationController } from "../electron/main/CodexIntegrationController"
import { notTestedHost } from "../adapter/codex/hooks/HookHostSelfTest"
const m = vi.hoisted(() => ({ inspect: vi.fn() }))
vi.mock("../adapter/codex/runtime/CodexExecutable.ts", async original => ({ ...await original<object>(), inspectOfficialCodexExecutable: m.inspect }))
const roots: string[] = [], doctors: HookSetupDoctor[] = []
afterEach(async () => { for (const d of doctors.splice(0)) d.dispose(); vi.restoreAllMocks(); m.inspect.mockReset(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture(version = "0.154.0", feature = "hooks stable true", broken = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "official-hook-test-"))); roots.push(root)
  const bin = join(root, "bin"), home = join(root, "home"), userData = join(root, "user-data")
  await Promise.all([bin, home, userData].map(path => mkdir(path)))
  const executable = join(bin, process.platform === "win32" ? "codex.exe" : "codex")
  const data = structuredClone(schemas)
  if (broken) data.Stop.properties.turn_id.type = "number"
  const binary = Buffer.from("MZ synthetic, never executed\0" + Object.entries(data).map(([event, schema]) =>
    JSON.stringify(schema, null, 2) + "\0" + (event === "SessionEnd" ? "" : JSON.stringify({ $schema: "http://json-schema.org/draft-07/schema#", title: schema.title.replace(/input$/, "output"), type: "object", properties: {} }, null, 2))).join("\0"))
  await writeFile(executable, binary, { mode: 0o700 })
  await writeFile(join(home, "config.toml"), "[features]\nhooks = true\n")
  const runtime = { kind: "official", version, executableSha256: createHash("sha256").update(binary).digest("hex"), executableBytes: binary.length }
  m.inspect.mockResolvedValue({ executable, runtime })
  const doctor = new HookSetupDoctor({ environment: { PATH: bin }, defaultHome: home, policyPath: null }); doctors.push(doctor)
  const probe = vi.spyOn(doctor as any, "probe").mockImplementation(async (_path, args: any) => args[0] === "--version" ? `codex-cli ${version}` : feature)
  return { root, home, userData, executable, runtime, doctor, probe, selection: { executablePath: null, codexHome: home } }
}

describe("official CLI Hook setup shares runtime admission", () => {
  it.each(["0.154.0", "0.155.0", "1.0.0"])("admits verified official %s through the real doctor and Hook installation preview", async version => {
    const f = await fixture(version)
    const status = await f.doctor.inspect(f.selection)
    expect(status.executable.probeStatus).toBe("verified")
    expect(status.capability.source).toBe("official-artifact-and-embedded-schemas")
    expect(Object.values(status.capability.events)).toEqual(Array(9).fill("supported"))
    const adapter: any = { state: "READY", adapterOwnership: "OWNED_UTILITY", activeRunCount: 0, activeTaskCount: 0, hookEvents: [] }
    const controller = new CodexIntegrationController({ userData: f.userData, appVersion: "0.8.1", packaged: true, platform: process.platform === "win32" ? "win32" : "darwin", doctor: f.doctor,
      launchSpec: { mode: process.platform === "win32" ? "packaged-windows-host" : "packaged-electron-node",
        executablePath: join(f.root, process.platform === "win32" ? "Pet/resources/codex/hook-host.exe" : "Pet.app/Contents/MacOS/Pet"),
        forwarderPath: join(f.root, process.platform === "win32" ? "Pet/resources/codex/hook-forwarder.mjs" : "Pet.app/Contents/Resources/codex/hook-forwarder.mjs"),
        dataDir: join(f.root, "adapter"), hookEndpoint: "http://127.0.0.1:4175/hook" },
      getAdapterDiagnostics: () => adapter, getFreshAdapterDiagnostics: async () => adapter,
      inspectHost: async () => ({ available: true, reason: "ready", fingerprint: "test-host", runAsNode: "enabled", temporaryLocation: false }),
      selfTest: async () => ({ ...notTestedHost(), status: "passed", hostFingerprint: "test-host", checkedAt: Date.now() }) })
    try {
      await controller.start(); controller.windowOpened("test-settings"); await controller.prepareConnection("test-settings")
      const plan = await controller.planHooks("install", "test-settings")
      expect(plan.conflicts).not.toContain("CAPABILITY_CONTRACT_UNKNOWN")
      expect(plan.canApply).toBe(true)
      await expect(readFile(join(f.home, "hooks.json"))).rejects.toThrow() // Preview remains read-only.
    } finally { await controller.dispose() }
  })
  it("does not auto-probe or authorize a file that failed official byte verification", async () => {
    const f = await fixture(); m.inspect.mockRejectedValue(Error("CHAT_RUNTIME_UNSUPPORTED"))
    const value = await f.doctor.inspect(f.selection)
    expect(value.capability.contractId).toBeNull(); expect(f.probe).not.toHaveBeenCalled()
    const selected = await f.doctor.inspect({ ...f.selection, executablePath: f.executable })
    expect(selected.capability.contractId).toBeNull(); expect(f.probe).not.toHaveBeenCalled()
  })
  it("rejects incompatible embedded schemas before executing any feature probe", async () => {
    const f = await fixture("0.154.1", "hooks stable true", true)
    expect((await f.doctor.inspect(f.selection)).capability.contractId).toBeNull()
    expect(f.probe).not.toHaveBeenCalled()
  })
  it("does not promote config.toml true when the admitted CLI omits the feature", async () => {
    const f = await fixture("0.154.0", "other stable true")
    expect((await f.doctor.inspect(f.selection)).feature).toBe("unknown")
  })
  it("keeps disabled Hooks disabled and rejects a different probed version", async () => {
    const f = await fixture("0.154.0", "hooks stable false")
    expect((await f.doctor.inspect(f.selection)).feature).toBe("disabled")
    f.probe.mockResolvedValue("codex-cli 0.155.0")
    const changed = await f.doctor.inspect(f.selection, true)
    expect(changed.executable.probeStatus).toBe("version-mismatch"); expect(changed.capability.contractId).toBeNull()
  })
  it("cancels pending official verification on disposal", async () => {
    const f = await fixture()
    m.inspect.mockImplementation((_path, signal: AbortSignal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(Error("aborted")), { once: true })))
    const pending = f.doctor.inspect(f.selection)
    await vi.waitFor(() => expect(m.inspect).toHaveBeenCalled())
    f.doctor.dispose(); await expect(pending).rejects.toThrow(); expect(f.probe).not.toHaveBeenCalled()
  })
  it("accepts additive schema data but rejects removed required fields and changed event identities", () => {
    const input: any = structuredClone(schemas.Stop); input.properties.newField = { type: "string" }; input.required.push("newField")
    expect(() => assertCompatibleHookInput(input, schemas.Stop)).not.toThrow()
    input.properties.hook_event_name.const = "SomethingElse"
    expect(() => assertCompatibleHookInput(input, schemas.Stop)).toThrow()
    input.properties.hook_event_name.const = "Stop"; input.required = input.required.filter((key: string) => key !== "turn_id")
    expect(() => assertCompatibleHookInput(input, schemas.Stop)).toThrow()
  })
  it("does not create a new dynamic contract below the minimum version", async () => {
    const f = await fixture("0.153.9")
    await expect(officialHookContract(f.executable, f.runtime, new AbortController().signal)).rejects.toThrow()
  })
})
