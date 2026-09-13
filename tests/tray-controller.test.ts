import { describe, expect, it, vi } from "vitest"
import { defaultDesktopSettings } from "../electron/shared/desktop-settings"

const electronMocks = vi.hoisted(() => ({ trayConstructor: vi.fn() }))

vi.mock("electron", () => ({
  Menu: { buildFromTemplate: vi.fn((value) => value) },
  Tray: class { constructor(...args: unknown[]) { electronMocks.trayConstructor(...args) } },
  dialog: { showMessageBox: vi.fn() },
  nativeImage: { createFromBuffer: vi.fn(() => ({ isEmpty: () => false, setTemplateImage: vi.fn(), addRepresentation: vi.fn() })) },
}))

describe("tray menu", () => {
  it("adds the shared activity summary and entry without changing the existing click action", async () => {
    const { buildTrayMenu } = await import("../electron/main/TrayController")
    const openActivity = vi.fn(), toggleVisible = vi.fn()
    const menu = buildTrayMenu(defaultDesktopSettings(), { state: "READY", message: null, restartCount: 0 }, {
      openActivity, toggleVisible, activity: () => ({ connection: "READY", counts: { running: 1, waiting: 1, failed: 2, completed: 3, attention: 6 } }),
    } as never)
    menu[0].click?.({} as never, {} as never, {} as never)
    expect(toggleVisible).toHaveBeenCalledOnce()
    const entry = menu.find(item => item.label === "작업 목록")!
    entry.click?.({} as never, {} as never, {} as never)
    expect(openActivity).toHaveBeenCalledOnce()
    expect(menu.some(item => item.label === "입력 필요 1 · 미확인 실패 2 · 미확인 종료 3 · 실행 중 1")).toBe(true)
  })

  it("retains the character context menu when native Tray creation fails", async () => {
    const { Menu } = await import("electron")
    const { TrayController } = await import("../electron/main/TrayController")
    const popup = vi.fn()
    vi.mocked(Menu.buildFromTemplate).mockReturnValueOnce({ popup } as never)
    electronMocks.trayConstructor.mockImplementationOnce(() => { throw new Error("unavailable tray") })
    const tray = new TrayController()
    expect(tray.create(defaultDesktopSettings(), { state: "READY", message: null, restartCount: 0 }, {} as never)).toBe(false)
    expect(tray.popup({} as never)).toBe(true)
    expect(popup).toHaveBeenCalledOnce()
    tray.destroy()
  })
  it("creates a non-empty 18px PNG template instead of relying on unsupported SVG data URLs", async () => {
    const { nativeImage } = await import("electron")
    const { createTrayIcon } = await import("../electron/main/TrayController")
    expect(createTrayIcon().isEmpty()).toBe(false)
    expect(vi.mocked(nativeImage.createFromBuffer)).toHaveBeenCalledWith(expect.any(Buffer))
    expect(vi.mocked(nativeImage.createFromBuffer).mock.calls[0][0].byteLength).toBeGreaterThan(100)
  })

  it("detects whether macOS assigned the Tray to a visible display", async () => {
    const { intersectsDisplay } = await import("../electron/main/TrayController")
    const displays = [{ x: 0, y: 0, width: 2056, height: 1329 }]
    expect(intersectsDisplay({ x: 1800, y: 0, width: 32, height: 24 }, displays)).toBe(true)
    expect(intersectsDisplay({ x: 0, y: 1329, width: 32, height: 24 }, displays)).toBe(false)
  })

  it("avoids stable Tray GUID placement state in the current unsigned builds", async () => {
    const { createNativeTray } = await import("../electron/main/TrayController")
    const image = {} as never
    electronMocks.trayConstructor.mockClear()

    createNativeTray(image)

    expect(electronMocks.trayConstructor).toHaveBeenNthCalledWith(1, image)
    expect(electronMocks.trayConstructor).toHaveBeenCalledTimes(1)
  })

  it("reflects visibility, character, scale, window, click-through, adapter, and quit state", async () => {
    const { buildTrayMenu } = await import("../electron/main/TrayController")
    const settings = { ...defaultDesktopSettings(), characterId: "gpichan" as const, scale: 1.25, visible: false, clickThrough: false }
    const actions = {
      toggleVisible: vi.fn(), setLayout: vi.fn(), resetPosition: vi.fn(), updateSettings: vi.fn(), openMotionLab: vi.fn(), reloadPet: vi.fn(), restartAdapter: vi.fn(), diagnostics: vi.fn(() => ({})), quit: vi.fn(),
    }
    const menu = buildTrayMenu(settings, { state: "READY", message: null, restartCount: 0 }, actions as never) as Array<Record<string, any>>
    expect(menu[0].label).toBe("Show Character")
    expect(menu.find((item) => item.label === "Character")!.submenu).toMatchObject([{ label: "지피쨩", checked: true }])
    expect(menu.find((item) => item.label === "Character")!.submenu).toHaveLength(1)
    menu.find((item) => item.label === "Character")!.submenu[0].click()
    expect(actions.updateSettings).toHaveBeenCalledWith({ characterId: "gpichan" })
    expect(menu.find((item) => item.label === "Scale")!.submenu.find((item: Record<string, unknown>) => item.label === "125%")).toMatchObject({ checked: true })
    expect(menu.find((item) => item.label === "Click-through")!.submenu[1]).toMatchObject({ label: "Disabled", checked: true })
    expect(menu.find((item) => item.label === "Codex Adapter")!.submenu[0].label).toBe("Status: READY (Owned)")
    expect(menu.at(-1)?.label).toBe("Quit")
  })
})

describe("speech bubble Tray toggle", () => {
  it.each([true, false])("reflects %s and saves the opposite value", async (speechBubblesEnabled) => {
    const { buildTrayMenu } = await import("../electron/main/TrayController")
    const updateSettings = vi.fn()
    const menu = buildTrayMenu({ ...defaultDesktopSettings(), speechBubblesEnabled }, { state: "READY", message: null, restartCount: 0 }, { updateSettings } as never)
    const toggle = menu.find((item) => item.label === "Show Speech Bubbles")!
    expect(toggle).toMatchObject({ type: "checkbox", checked: speechBubblesEnabled })
    toggle.click?.({} as never, {} as never, {} as never)
    expect(updateSettings).toHaveBeenCalledWith({ speechBubblesEnabled: !speechBubblesEnabled })
  })
})
