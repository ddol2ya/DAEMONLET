import { describe, expect, it } from "vitest"
import { createHookCommand, validateLaunchSpec, windowsHookArguments, type HookLaunchSpec } from "../adapter/codex/hooks/HookLaunchSpec"
import { classifyHandler, hookHandler } from "../adapter/codex/hooks/HookInstallPlan"
const spec: HookLaunchSpec = { mode: "packaged-windows-host", executablePath: "C:\\Test Apps\\한글 & O'Neil\\Daemonlet for Codex\\resources\\codex\\hook-host.exe", forwarderPath: "C:\\Test Apps\\한글 & O'Neil\\Daemonlet for Codex\\resources\\codex\\hook-forwarder.mjs", dataDir: "C:\\Test Data\\한글 & O'Neil\\Daemonlet for Codex\\adapter", hookEndpoint: "discover" }
describe("packaged Windows Hook launch", () => {
  it("uses one quoted native launcher with encoded values and a stable endpoint", () => {
    const command = createHookCommand(spec), args = windowsHookArguments(spec)
    expect(command.startsWith(`"${spec.executablePath}" `)).toBe(true)
    expect(command).not.toContain("NODE_OPTIONS")
    expect(command).not.toContain("powershell")
    expect(args[0]).toMatch(/^[a-f0-9]+$/)
    expect(args[0].match(/.{4}/g)?.map(value => String.fromCharCode(parseInt(value, 16))).join("")).toBe(spec.dataDir)
    expect(hookHandler(spec).timeout).toBe(3)
  })
  it.each(["%TEMP%", "bad!name", 'bad"name', "bad\nname"])("rejects shell expansions and controls: %s", name => {
    expect(() => validateLaunchSpec({ ...spec, dataDir: `C:\\${name}` })).toThrow("INVALID_LAUNCH_PATH")
  })
  it.each(["https://example.com/hook", "http://127.0.0.1:65536/hook", "http://127.0.0.1:0/hook"])("rejects invalid endpoints: %s", hookEndpoint => {
    expect(() => validateLaunchSpec({ ...spec, hookEndpoint })).toThrow()
  })
  it("requires review for altered native host handlers instead of treating them as unrelated", () => {
    const desired = hookHandler(spec), altered = { ...desired, command: desired.command + " altered" }
    expect(classifyHandler(altered, { hooks: [altered] }, { desiredHandler: desired })).toBe("ambiguous")
  })
})
