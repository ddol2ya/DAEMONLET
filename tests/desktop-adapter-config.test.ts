import { describe, expect, it } from "vitest"
import { createDesktopAdapterRuntimeConfig, prepareDesktopAdapterPorts } from "../electron/main/DesktopAdapterConfig"
import { createServer } from "node:net"

describe("desktop adapter runtime config", () => {
  it("uses loopback-only defaults", () => {
    const config = createDesktopAdapterRuntimeConfig({})
    expect(config).toMatchObject({
      protocolHost: "127.0.0.1",
      protocolPort: 4474,
      protocolEndpoint: "ws://127.0.0.1:4474/events",
      hookHost: "127.0.0.1",
      hookPort: 4475,
      hookEndpoint: "http://127.0.0.1:4475/hook",
    })
    expect(config.dataDir).toMatch(/\.daemonlet-for-codex$/)
  })

  it("validates overrides and derives consistent endpoints", () => {
    const config = createDesktopAdapterRuntimeConfig({
      CODEX_PET_PROTOCOL_PORT: "50101",
      CODEX_PET_HOOK_PORT: "50102",
      CODEX_PET_DATA_DIR: "relative-smoke-data",
    })
    expect(config.protocolEndpoint).toBe("ws://127.0.0.1:50101/events")
    expect(config.hookEndpoint).toBe("http://127.0.0.1:50102/hook")
    expect(config.dataDir).toMatch(/[\\/]relative-smoke-data$/)
  })

  it.each(["0", "65536", "1.5", "NaN", ""])("rejects invalid port %j", (value) => {
    expect(() => createDesktopAdapterRuntimeConfig({ CODEX_PET_PROTOCOL_PORT: value })).toThrow("invalid desktop adapter port")
  })
  it("allocates separate available Windows ports and releases its reservations", async () => {
    const environment: NodeJS.ProcessEnv = {}
    await prepareDesktopAdapterPorts(environment, "win32")
    const config = createDesktopAdapterRuntimeConfig(environment)
    expect(config.protocolPort).not.toBe(config.hookPort)
    for (const port of [config.protocolPort, config.hookPort]) {
      const server = createServer()
      try { await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve) }) }
      finally { await new Promise<void>(resolve => server.close(() => resolve())) }
    }
  })
  it("preserves explicit ports and leaves Unix defaults unchanged", async () => {
    const overrides = { CODEX_PET_PROTOCOL_PORT: "50101", CODEX_PET_HOOK_PORT: "50102" }
    await prepareDesktopAdapterPorts(overrides, "win32")
    expect(overrides).toEqual({ CODEX_PET_PROTOCOL_PORT: "50101", CODEX_PET_HOOK_PORT: "50102" })
    const unix = {}
    await prepareDesktopAdapterPorts(unix, "darwin")
    expect(unix).toEqual({})
  })
})
