import { expect, it, vi } from "vitest"
import { join } from "node:path"

const state = vi.hoisted(() => ({ paths: new Map<string, string>([["appData", "/profiles"], ["userData", "/profiles/Legacy Pet"]]), lockedProfile: "" }))
vi.mock("electron", () => ({ app: {
  isPackaged: true, enableSandbox: vi.fn(), setName: vi.fn(), setAppUserModelId: vi.fn(), quit: vi.fn(),
  getPath: (key: string) => state.paths.get(key), setPath: (key: string, value: string) => state.paths.set(key, value),
  requestSingleInstanceLock: () => { state.lockedProfile = state.paths.get("userData")!; return false },
} }))
vi.mock("../electron/main/AppController", () => ({ AppController: class {} }))
vi.mock("../electron/main/AppProtocol", () => ({ registerAppScheme: vi.fn() }))
vi.mock("../electron/main/SetupSmoke", () => ({}))
vi.mock("../electron/main/CharacterPackWorker", () => ({}))

it("uses the application profile before the real entry point requests its instance lock", async () => {
  vi.stubEnv("ELECTRON_SMOKE_USER_DATA", "")
  try {
    await import("../electron/main/main")
    expect(state.lockedProfile).toBe(join("/profiles", "Daemonlet for Codex"))
    expect(state.paths.get("sessionData")).toBe(state.lockedProfile)
  } finally { vi.unstubAllEnvs() }
})
