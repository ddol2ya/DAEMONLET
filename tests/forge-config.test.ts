import { describe, expect, it } from "vitest"
import forgeConfig from "../forge.config.mjs"

describe("Electron Forge configuration", () => {
  it("uses a stable project-owned macOS bundle identity", () => {
    expect(forgeConfig.packagerConfig).toMatchObject({
      appBundleId: "io.github.ddol2ya.daemonlet",
      extendInfo: { LSUIElement: true },
    })
  })
})
