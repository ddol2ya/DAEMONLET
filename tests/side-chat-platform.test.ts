import { sideChatCandidates } from "../electron/main/side-chat/SideChatDiscovery"
import { findOfficialRuntime, OFFICIAL_RUNTIME_REGISTRY } from "../electron/main/side-chat/OfficialRuntimeRegistry"
import { describe, expect, it } from "vitest"
import { officialRuntimeEnvironment, officialSystemConfigFiles } from "../electron/main/side-chat/OfficialPlatform"

describe("official Windows companion environment", () => {
  it("reads the same ProgramData policy path that the child process will use", () => {
    const env = { ProgramData: "D:\\Shared", SystemRoot: "D:\\Windows", APPDATA: "D:\\User\\Roaming", LOCALAPPDATA: "D:\\User\\Local", OPENAI_API_KEY: "forbidden", PATH: "unsafe", NODE_OPTIONS: "forbidden" }
    const child = officialRuntimeEnvironment("D:\\User", "D:\\User\\.codex", "D:\\Temp", "win32", env)
    expect(officialSystemConfigFiles("win32", env)).toEqual(["D:\\Shared\\OpenAI\\Codex\\config.toml", "D:\\Shared\\OpenAI\\Codex\\requirements.toml"])
    expect(child).toMatchObject({ ProgramData: env.ProgramData, SystemRoot: env.SystemRoot, APPDATA: env.APPDATA, LOCALAPPDATA: env.LOCALAPPDATA, CODEX_HOME: "D:\\User\\.codex", PATH: "D:\\Windows\\System32" })
    expect(child).not.toHaveProperty("OPENAI_API_KEY"); expect(child).not.toHaveProperty("NODE_OPTIONS")
    expect(officialSystemConfigFiles("win32", child)).toEqual(officialSystemConfigFiles("win32", env))
  })
  it("rejects relative or malformed system locations and preserves the macOS environment", () => {
    for (const ProgramData of ["relative", "C:\\bad\npath"]) expect(() => officialSystemConfigFiles("win32", { ProgramData })).toThrow("CHAT_EXECUTION_POLICY")
    expect(() => officialRuntimeEnvironment("C:\\User", "C:\\.codex", "C:\\Temp", "win32", { APPDATA: "relative" })).toThrow("CHAT_EXECUTION_POLICY")
    expect(officialRuntimeEnvironment("/user", "/user/.codex", "/tmp/chat", "darwin", { OPENAI_API_KEY: "forbidden" })).toEqual({ HOME: "/user", USERPROFILE: "/user", CODEX_HOME: "/user/.codex", TMPDIR: "/tmp/chat", TMP: "/tmp/chat", TEMP: "/tmp/chat", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" })
  })
})

it("never admits another platform binary even when its hash is reviewed", () => {
  const win = OFFICIAL_RUNTIME_REGISTRY.find(r => r.platform === "win32")!
  expect(findOfficialRuntime(win.executableSha256, win.executableBytes, "win32", "x64")).toBe(win)
  expect(findOfficialRuntime(win.executableSha256, win.executableBytes, "darwin", "arm64")).toBeUndefined()
  expect(findOfficialRuntime(win.executableSha256, win.executableBytes, "win32", "arm64")).toBeUndefined()
  expect(findOfficialRuntime(win.executableSha256, win.executableBytes + 1, "win32", "x64")).toBeUndefined()
})

it("keeps redirected and standard Windows npm installs inside the bounded scan on a long PATH", () => {
  const PATH = Array.from({ length: 60 }, (_, i) => `C:\\Tools\\${i}`).join(";")
  const candidates = sideChatCandidates(null, { PATH, APPDATA: "D:\\Roaming" }, "C:\\Users\\Example", "win32")
  expect(candidates.length).toBeLessThanOrEqual(48)
  expect(candidates[0]).toBe("D:\\Roaming\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe")
  expect(candidates[1]).toContain("C:\\Users\\Example\\AppData\\Roaming\\npm")
  expect(sideChatCandidates("C:\\selected\\codex.cmd", { PATH }, "C:\\Users\\Example", "win32")).toEqual(["C:\\selected\\codex.cmd"])
})
