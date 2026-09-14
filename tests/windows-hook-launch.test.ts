import { afterEach, describe, expect, it, vi } from "vitest"
import { containsHookMarker, createHookCommand, validateLaunchSpec, windowsHookArguments, windowsHookShellPath, type HookLaunchSpec } from "../adapter/codex/hooks/HookLaunchSpec"
import { allEventSupport, classifyHandler, handlerIdentity, hookHandler, planHookEdit } from "../adapter/codex/hooks/HookInstallPlan"
const spec: HookLaunchSpec = { mode: "packaged-windows-host", executablePath: "C:\\Test Apps\\한글 & O'Neil\\Daemonlet for Codex\\resources\\codex\\hook-host.exe", forwarderPath: "C:\\Test Apps\\한글 & O'Neil\\Daemonlet for Codex\\resources\\codex\\hook-forwarder.mjs", dataDir: "C:\\Test Data\\한글 & O'Neil\\Daemonlet for Codex\\adapter", hookEndpoint: "discover" }
describe("packaged Windows Hook launch", () => {
  afterEach(() => vi.unstubAllEnvs())
  it("emits one absolute system-shell command usable by CMD and PowerShell", () => {
    const command = createHookCommand(spec), args = windowsHookArguments(spec)
    const [shell, ...flags] = command.split(" ")
    expect(shell).toBe(windowsHookShellPath())
    expect(flags.slice(0, 4)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"])
    expect(flags[4]).toMatch(/^[a-zA-Z0-9+/]+=*$/)
    const invocation = Buffer.from(flags[4], "base64").toString("utf16le")
    expect(invocation.startsWith("& 'C:\\Test Apps\\한글 & O''Neil\\Daemonlet for Codex\\resources\\codex\\hook-host.exe' ")).toBe(true)
    expect(invocation.endsWith(args.map(value => `'${value}'`).join(" "))).toBe(true)
    expect(command).not.toContain("NODE_OPTIONS")
    expect(command).not.toMatch(/ExecutionPolicy|Bypass|daemonlet-codex-pet-adapter.*[;&]/i)
    expect(args[0]).toMatch(/^[a-f0-9]+$/)
    expect(args[0].match(/.{4}/g)?.map(value => String.fromCharCode(parseInt(value, 16))).join("")).toBe(spec.dataDir)
    expect(hookHandler(spec).timeout).toBe(3)
  })
  it("keeps PowerShell substitution syntax literal inside the encoded invocation", () => {
    const executablePath = spec.executablePath.replace("한글 & O'Neil", "$HOME $(whoami) `name & O'Neil")
    const forwarderPath = executablePath.replace("hook-host.exe", "hook-forwarder.mjs")
    const command = createHookCommand({ ...spec, executablePath, forwarderPath })
    const invocation = Buffer.from(command.split(" ").at(-1)!, "base64").toString("utf16le")
    expect(invocation).toContain("& 'C:\\Test Apps\\$HOME $(whoami) `name & O''Neil\\")
  })
  it.each(["C:\\Windows & injected", "C:\\Windows'bad", "C:\\Windows space", "$env:windir", "C:\\Windows\\.."])("refuses a system-shell path requiring shell expansion: %s", root => {
    vi.stubEnv("SystemRoot", root)
    expect(() => createHookCommand(spec)).toThrow("INVALID_SYSTEM_SHELL_PATH")
  })
  it("rejects an encoded command exceeding the CMD command-line budget", () => {
    expect(() => createHookCommand({ ...spec, dataDir: `C:\\${"a".repeat(1000)}` })).toThrow("INVALID_LAUNCH_PATH")
  })
  it.each(["%TEMP%", "bad!name", 'bad"name', "bad\nname", "bad\u2018name", "bad\u2019name", "bad\u201cname", "bad\u201dname"])("rejects ambiguous shell syntax and controls: %s", name => {
    expect(() => validateLaunchSpec({ ...spec, dataDir: `C:\\${name}` })).toThrow("INVALID_LAUNCH_PATH")
  })
  it.each(["https://example.com/hook", "http://127.0.0.1:65536/hook", "http://127.0.0.1:0/hook"])("rejects invalid endpoints: %s", hookEndpoint => {
    expect(() => validateLaunchSpec({ ...spec, hookEndpoint })).toThrow()
  })
  it("requires review for altered native host handlers instead of treating them as unrelated", () => {
    const desired = hookHandler(spec), altered = { ...desired, command: desired.command + " altered" }
    expect(classifyHandler(altered, { hooks: [altered] }, { desiredHandler: desired })).toBe("ambiguous")
  })
  it("preserves ownership of the previous CMD registration through its receipt", () => {
    const previous = { type: "command", command: `"${spec.executablePath}" ${windowsHookArguments(spec).join(" ")}`, timeout: 3 }
    expect(classifyHandler(previous, { hooks: [previous] }, { desiredHandler: hookHandler(spec) })).toBe("ambiguous")
    const foreign = { type: "command", command: "echo foreign" }
    const plan = planHookEdit({ action: "repair", before: JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [previous, foreign] }] } }), context: { desiredHandler: hookHandler(spec), receipts: [handlerIdentity(previous)] }, support: allEventSupport("supported") })
    expect(plan.conflicts).toEqual([])
    expect(plan.changed).toBe(true)
    const after = JSON.parse(plan.after!).hooks.UserPromptSubmit
    expect(after.flatMap((group: { hooks: unknown[] }) => group.hooks)).toEqual([foreign, hookHandler(spec)])
    expect(plan.warnings).toContain("HOOK_REVIEW_REQUIRED")
  })
  it("recognizes encoded registrations for diagnostics without granting ownership", () => {
    expect(containsHookMarker({ UserPromptSubmit: [{ hooks: [hookHandler(spec)] }] })).toBe(true)
    expect(containsHookMarker({ command: "powershell -EncodedCommand ZWNobyBmb3JlaWdu" })).toBe(false)
  })
})
