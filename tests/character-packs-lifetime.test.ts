import { afterEach, describe, expect, it, vi } from "vitest"
import type { SettingsDesktopApi } from "../electron/shared/codex-integration-contract"
import { CharacterPacks } from "../src/settings/CharacterPacks"

const hooks = vi.hoisted(() => ({ effects: [] as Array<() => void | (() => void)>, setState: vi.fn() }))
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (value: unknown) => [value, hooks.setState], useRef: () => ({ current: null }), useEffect: (effect: () => void | (() => void)) => hooks.effects.push(effect),
}))
vi.mock("../src/i18n/useLanguage", () => ({ useT: () => (value: unknown) => value }))
afterEach(() => { hooks.effects.length = 0; hooks.setState.mockClear() })
describe("character tab read lifetime", () => {
  it("loads its snapshot while an Updates action owns the mutation runner; tab retirement cancels no remote import", async () => {
    let deliver!: (value: unknown) => void
    const unsub = vi.fn(), list = vi.fn(() => new Promise(resolve => { deliver = resolve })), cancel = vi.fn()
    const api = { packUpdates: { list: async () => [], onChanged: () => unsub }, characters: { list, onChanged: () => unsub, onProgress: () => unsub, cancelImport: cancel } } as unknown as SettingsDesktopApi
    const busyRun = vi.fn(async () => undefined)
    CharacterPacks({ api, run: busyRun, busy: "Updates", selected: "gpichan" })
    const cleanup = hooks.effects.map(effect => effect())
    expect(list).toHaveBeenCalledOnce(); expect(busyRun).not.toHaveBeenCalled()
    cleanup.forEach(dispose => dispose?.())
    await Promise.resolve(); hooks.setState.mockClear()
    deliver({ generation: 1, entries: [] }); await Promise.resolve(); await Promise.resolve()
    expect(hooks.setState).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled(); expect(unsub).toHaveBeenCalledTimes(3)
  })
})
