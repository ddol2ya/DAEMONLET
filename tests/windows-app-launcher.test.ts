import { describe, expect, it, vi } from "vitest"
import { CodexAppLauncher } from "../electron/main/activity/CodexAppLauncher"

const root = String.raw`C:\Program Files\WindowsApps\OpenAI.Codex_test`
const path = root + String.raw`\app\ChatGPT.exe`
const thread = "01234567-89ab-7cde-8fab-0123456789ab"
function fixture(overrides: Record<string, unknown> = {}) {
  const registered = {
    family: "OpenAI.Codex_2p2nqsd0c76g0", publisher: "CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B",
    status: "Ok", development: false, signatureKind: "Store", signatureStatus: "Valid",
    signer: 'CN="OpenAI OpCo, LLC", O="OpenAI OpCo, LLC", C=US',
    root, path, supportsThreads: true, ...overrides,
  }
  const run = vi.fn(async (_file: string, _args: string[]) => JSON.stringify(registered))
  const launch = vi.fn(async (_file: string, _args: string[]) => {})
  const realpath = vi.fn(async (value: string) => value)
  const stat = vi.fn(async () => ({ isFile: (): boolean => true }))
  const app = new CodexAppLauncher({ platform: "win32", run, launch, realpath: realpath as never, stat: stat as never })
  return { app, run, launch, realpath, stat, registered }
}

describe("Windows registered Codex app navigation", () => {
  it("discovers the current user's verified Store app and launches it directly with separate arguments", async () => {
    const f = fixture()
    expect(await f.app.available()).toBe(true)
    expect(f.launch).not.toHaveBeenCalled()
    expect(f.run.mock.calls[0][0]).toMatch(/\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i)
    expect(f.run.mock.calls[0][1].slice(0, 4)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"])
    expect(await f.app.open()).toBe("opened")
    expect(f.launch).toHaveBeenLastCalledWith(path, [])
    expect(await f.app.openThread(thread)).toBe("opened")
    expect(f.launch).toHaveBeenLastCalledWith(path, ["codex://threads/" + thread])
    expect(await f.app.bundledExecutable()).toBeNull()
  })

  it.each([
    { family: "Other.App_family" }, { publisher: "CN=Other" }, { status: "Modified" },
    { development: true }, { signatureKind: "Developer" }, { signatureStatus: "NotSigned" },
    { signatureStatus: "HashMismatch" }, { signer: "O=Other" }, { signer: 'O="OpenAI OpCo, LLC Evil"' },
    { path: "relative.exe" }, { path: String.raw`\\server\share\app.exe` },
    { path: path + "\n" }, { root: null }, { path: null }, { path: root + "\\app\\bad.cmd" },
    { path: root + "-other\\ChatGPT.exe" }, { path: root + "\\..\\outside.exe" },
  ])("refuses untrusted packages and invalid paths: %j", async overrides => {
    const f = fixture(overrides)
    expect(await f.app.available()).toBe(false)
    expect(await f.app.open()).toBe("unavailable")
    expect(f.launch).not.toHaveBeenCalled()
  })

  it("rejects canonical path escapes and missing executables", async () => {
    const f = fixture()
    f.realpath.mockImplementation(async value => value === path ? String.raw`C:\Other\ChatGPT.exe` : value)
    expect(await f.app.open()).toBe("unavailable")
    f.realpath.mockImplementation(async value => value)
    f.stat.mockResolvedValueOnce({ isFile: () => false })
    expect(await f.app.open()).toBe("unavailable")
    f.stat.mockRejectedValueOnce(new Error("ENOENT"))
    expect(await f.app.open()).toBe("unavailable")
    expect(f.launch).not.toHaveBeenCalled()
  })

  it("keeps app-only launch available without a codex protocol and rejects malformed thread IDs before discovery", async () => {
    const f = fixture({ supportsThreads: false })
    expect(await f.app.open()).toBe("opened")
    expect(await f.app.openThread(thread)).toBe("unavailable")
    f.run.mockClear()
    for (const invalid of ["codex://threads/new?prompt=bad", thread + "?prompt=bad", thread + "/other", "--args", "$(command)"]) {
      expect(await f.app.openThread(invalid)).toBe("unavailable")
    }
    expect(f.run).not.toHaveBeenCalled()
    expect(f.launch).toHaveBeenCalledOnce()
  })

  it("reports missing/query failures as unavailable, spawn errors as failed, and retries after failure", async () => {
    const f = fixture()
    for (const response of ["", "null", "{}", "not JSON"]) {
      f.run.mockResolvedValueOnce(response)
      expect(await f.app.open()).toBe("unavailable")
    }
    f.run.mockRejectedValueOnce(new Error("query timeout"))
    expect(await f.app.open()).toBe("unavailable")
    f.launch.mockRejectedValueOnce(new Error("EACCES"))
    expect(await f.app.open()).toBe("failed")
    expect(await f.app.open()).toBe("opened")
  })

  it("rechecks registration after discovery and prevents overlapping launches", async () => {
    const f = fixture()
    expect(await f.app.available()).toBe(true)
    f.registered.signatureStatus = "HashMismatch"
    expect(await f.app.open()).toBe("unavailable")
    expect(f.launch).not.toHaveBeenCalled()
    f.registered.signatureStatus = "Valid"
    let finish!: () => void
    f.launch.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    const pending = f.app.open()
    await vi.waitFor(() => expect(f.launch).toHaveBeenCalledOnce())
    expect(await f.app.open()).toBe("failed")
    finish()
    expect(await pending).toBe("opened")
  })
})
