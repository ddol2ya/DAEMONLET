import { describe, expect, it, vi } from "vitest"
import { CodexAppLauncher } from "../electron/main/activity/CodexAppLauncher"

function fixture() {
  const run = vi.fn(async (file: string): Promise<string> => file === "/usr/bin/osascript" ? "/Applications/ChatGPT.app" : file === "/usr/bin/plutil" ? "com.openai.codex" : "")
  const launcher = new CodexAppLauncher({ platform: "darwin", run, realpath: (async (p: string) => p) as never, stat: (async () => ({ isDirectory: () => true })) as never })
  return { launcher, run }
}

describe("host-owned app-only navigation", () => {
  it("uses an OS-registered, identity/signature-checked target with discrete arguments", async () => {
    const f = fixture()
    expect(await f.launcher.available()).toBe(true)
    expect(f.run).not.toHaveBeenCalledWith("/usr/bin/open", expect.anything())
    expect(await f.launcher.open()).toBe("opened")
    expect(f.run).toHaveBeenLastCalledWith("/usr/bin/open", ["-a", "/Applications/ChatGPT.app"])
    expect(f.run).toHaveBeenCalledWith("/usr/bin/codesign", ["--verify", "--strict", "-R", '=identifier "com.openai.codex" and anchor apple generic', "/Applications/ChatGPT.app"])
  })

  it.each(["", "https://evil.example", "/tmp/a.app\n/bin/sh", "relative.app", "/tmp/cli"])("rejects unavailable/invalid registered targets: %s", async value => {
    const f = fixture(); f.run.mockResolvedValueOnce(value)
    expect(await f.launcher.open()).toBe("unavailable")
    expect(f.run).not.toHaveBeenCalledWith("/usr/bin/open", expect.anything())
  })

  it("rejects identity mismatch/signature failure and reports launch failure", async () => {
    const f = fixture()
    f.run.mockResolvedValueOnce("/Applications/ChatGPT.app").mockResolvedValueOnce("evil.app")
    expect(await f.launcher.open()).toBe("unavailable")
    f.run.mockResolvedValueOnce("/Applications/ChatGPT.app").mockResolvedValueOnce("com.openai.codex").mockRejectedValueOnce(new Error("signature"))
    expect(await f.launcher.open()).toBe("unavailable")
    f.run.mockResolvedValueOnce("/Applications/ChatGPT.app").mockResolvedValueOnce("com.openai.codex").mockResolvedValueOnce("").mockRejectedValueOnce(new Error("PRIVATE_PATH"))
    expect(await f.launcher.open()).toBe("failed")
  })

  it("does not guess other-platform executables or URIs", async () => {
    const run = vi.fn()
    const launcher = new CodexAppLauncher({ platform: "win32", run })
    expect(await launcher.available()).toBe(false); expect(await launcher.open()).toBe("unavailable")
    expect(run).not.toHaveBeenCalled()
  })
})
