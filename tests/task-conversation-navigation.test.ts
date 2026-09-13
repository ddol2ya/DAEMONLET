import { describe, expect, it, vi } from "vitest"
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { CodexAppLauncher } from "../electron/main/activity/CodexAppLauncher"
import { CodexThreadLauncher } from "../electron/main/control/CodexThreadLauncher"
const thread = "01234567-89ab-7cde-8fab-0123456789ab"

describe("ChatGPT conversation navigation", () => {
  it("opens only the validated UUID route in the verified ChatGPT app with discrete arguments", async () => {
    const run = vi.fn(async (file: string, args: string[]) => file === "/usr/bin/osascript" ? "/Applications/ChatGPT.app" : file === "/usr/bin/plutil" ? args.includes("CFBundleURLTypes") ? '[{"CFBundleURLSchemes":["codex"]}]' : "com.openai.codex" : "")
    const app = new CodexAppLauncher({ platform: "darwin", run, realpath: (async (path: string) => path) as never, stat: (async () => ({ isDirectory: () => true })) as never })
    expect(await app.openThread(thread)).toBe("opened")
    expect(run).toHaveBeenLastCalledWith("/usr/bin/open", ["-a", "/Applications/ChatGPT.app", `codex://threads/${thread}`])
    for (const invalid of ["codex://threads/new?prompt=bad", `${thread}?prompt=bad`, `${thread}/other`, "--args", "$(command)"]) expect(await app.openThread(invalid)).toBe("unavailable")
    expect(run.mock.calls.filter(([file]) => file === "/usr/bin/open")).toHaveLength(1)
  })
  it("requires an existing matching rollout in the local profile and rejects another profile or symlink escape", async () => {
    const root = await mkdtemp(join(tmpdir(), "2dl-nav-test-")), home = join(root, "home"), elsewhere = join(root, "other")
    await mkdir(join(home, "sessions"), { recursive: true }); await mkdir(elsewhere)
    const file = join(home, "sessions", `rollout-probe-${thread}.jsonl`)
    const outside = join(elsewhere, `rollout-probe-${thread}.jsonl`)
    await writeFile(file, "{}\n"); await writeFile(outside, "{}\n")
    const app = { openThread: vi.fn(async () => "opened" as const) }
    let now = 1000
    const launcher = new CodexThreadLauncher({ home, app, now: () => now })
    try {
      await launcher.open({ threadId: thread, socketPath: "/unused/socket", rolloutPath: file })
      expect(app.openThread).toHaveBeenCalledExactlyOnceWith(thread)
      now += 3000
      await expect(launcher.open({ threadId: thread, socketPath: "/unused/socket", rolloutPath: outside })).rejects.toThrow("UNAVAILABLE")
      await rm(file); await symlink(outside, file); now += 3000
      await expect(launcher.open({ threadId: thread, socketPath: "/unused/socket", rolloutPath: file })).rejects.toThrow("UNAVAILABLE")
      expect(app.openThread).toHaveBeenCalledOnce()
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
