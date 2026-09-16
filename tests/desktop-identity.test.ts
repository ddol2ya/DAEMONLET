import { describe, expect, it, vi } from "vitest"
import { join, resolve } from "node:path"
import { configureDesktopIdentity } from "../electron/main/DesktopIdentity"
import { createDesktopAdapterRuntimeConfig } from "../electron/main/DesktopAdapterConfig"

const fakeApp = (isPackaged = true) => {
  const paths = new Map<string, string>([["appData", resolve("/profiles")], ["userData", resolve("/profiles/Legacy Pet")]])
  return { isPackaged, paths, setName: vi.fn(), setAppUserModelId: vi.fn(),
    getPath: (key: string) => paths.get(key)!, setPath: (key: string, value: string) => { paths.set(key, value) } }
}

describe("application identity", () => {
  it("ignores QA environment overrides in production while honoring an explicit app data profile", () => {
    vi.stubGlobal("__APP_QA__", false)
    try {
      const app = fakeApp(), env = { ELECTRON_SMOKE_USER_DATA: resolve("/qa/ignored"), DAEMONLET_DATA_HOME: resolve("/profiles/separate"), CODEX_HOME: "/preserved-codex" }
      configureDesktopIdentity(app, env, "darwin")
      expect(app.getPath("userData")).toBe(resolve("/profiles/separate")); expect(env.CODEX_HOME).toBe("/preserved-codex")
      const normal = fakeApp(); configureDesktopIdentity(normal, { ELECTRON_SMOKE_USER_DATA: resolve("/qa/ignored") }, "darwin")
      expect(normal.getPath("userData")).toBe(join(resolve("/profiles"), "Daemonlet for Codex"))
    } finally { vi.unstubAllGlobals() }
  })
  it.each(["darwin", "win32"] as const)("isolates ordinary %s startup without a smoke override", platform => {
    const app = fakeApp(), environment = { CODEX_HOME: "/actual-codex" }
    configureDesktopIdentity(app, environment, platform)
    const profile = join(resolve("/profiles"), "Daemonlet for Codex")
    expect(app.getPath("userData")).toBe(profile)
    expect(app.getPath("sessionData")).toBe(profile)
    expect(createDesktopAdapterRuntimeConfig(environment).dataDir).toBe(join(profile, "adapter"))
    expect(createDesktopAdapterRuntimeConfig(environment).protocolPort).not.toBe(4174)
    expect(createDesktopAdapterRuntimeConfig(environment).hookPort).not.toBe(4175)
    expect(environment.CODEX_HOME).toBe("/actual-codex")
    if (platform === "win32") expect(app.setAppUserModelId).toHaveBeenCalledWith("io.github.ddol2ya.daemonlet")
  })

  it("keeps developer runs out of both installed app profiles and Hook endpoints", () => {
    const app = fakeApp(false), env = {}
    configureDesktopIdentity(app, env, "darwin")
    expect(app.getPath("userData")).toBe(join(resolve("/profiles"), "Daemonlet for Codex Dev"))
    expect(createDesktopAdapterRuntimeConfig(env)).toMatchObject({ protocolPort: 4574, hookPort: 4575 })
  })

  it("retains explicit smoke paths and operator endpoint overrides", () => {
    const app = fakeApp(), env = { ELECTRON_SMOKE_USER_DATA: resolve("/qa/profile"), CODEX_PET_DATA_DIR: resolve("/qa/adapter"), CODEX_PET_PROTOCOL_PORT: "50101", CODEX_PET_HOOK_PORT: "50102" }
    configureDesktopIdentity(app, env, "darwin")
    expect(app.getPath("userData")).toBe(resolve("/qa/profile"))
    expect(createDesktopAdapterRuntimeConfig(env)).toMatchObject({ dataDir: resolve("/qa/adapter"), protocolPort: 50101, hookPort: 50102 })
  })
})
