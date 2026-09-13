import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WindowBoundsStore } from "../electron/main/WindowBoundsStore"
import { defaultDesktopSettings } from "../electron/shared/desktop-settings"

const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

describe("WindowBoundsStore", () => {
  it("atomically saves and loads settings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "desktop-settings-")); directories.push(directory)
    const store = new WindowBoundsStore(directory)
    const settings = { ...defaultDesktopSettings(), characterId: "gpichan" as const }
    await store.save(settings)
    expect((await store.load()).value).toEqual(settings)
    expect(await readFile(store.path, "utf8")).toContain('"gpichan"')
  })

  it("preserves the last settings when a pending save overlaps shutdown in the same millisecond", async () => {
    const directory = await mkdtemp(join(tmpdir(), "desktop-settings-overlap-")); directories.push(directory)
    const store = new WindowBoundsStore(directory)
    const now = vi.spyOn(Date, "now").mockReturnValue(1789180593750)
    const first = defaultDesktopSettings()
    const last = { ...first, visible: false, speechBubblesEnabled: false }
    try {
      const writes = await Promise.allSettled([store.save(first), store.save(last)])
      expect(writes.map(write => write.status)).toEqual(["fulfilled", "fulfilled"])
      expect((await store.load()).value).toEqual(last)
    } finally { now.mockRestore() }
  })

  it("quarantines a corrupt file and returns defaults", async () => {
    const directory = await mkdtemp(join(tmpdir(), "desktop-settings-corrupt-")); directories.push(directory)
    const store = new WindowBoundsStore(directory)
    await writeFile(store.path, "{")
    const loaded = await store.load()
    expect(loaded.value).toEqual(defaultDesktopSettings())
    expect(loaded.quarantinedPath).toContain(".corrupt-")
    expect(await readFile(loaded.quarantinedPath!, "utf8")).toBe("{")
  })
})
