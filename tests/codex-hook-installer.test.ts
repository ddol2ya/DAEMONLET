import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { INSTALLED_HOOK_EVENTS, manageHooks } from "../adapter/codex/hooks/HookInstaller.ts"

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

describe("HookInstaller", () => {
  it("dry-runs, preserves hooks, applies idempotently, backs up, and uninstalls only owned entries", async () => {
    expect(INSTALLED_HOOK_EVENTS).toHaveLength(9)
    expect(INSTALLED_HOOK_EVENTS).toContain("Interrupt")
    const codexHome = await mkdtemp(join(tmpdir(), "codex home with spaces-"))
    directories.push(codexHome)
    const original = { hooks: { Stop: [{ description: "existing", hooks: [{ type: "command", command: "true" }] }] } }
    await writeFile(join(codexHome, "hooks.json"), JSON.stringify(original))
    const options = { codexHome, projectRoot: "/project with spaces", nodePath: "/node with spaces/node" }
    const dry = await manageHooks({ ...options, action: "dry-run" })
    expect(dry.changed).toBe(true)
    expect(JSON.parse(await readFile(join(codexHome, "hooks.json"), "utf8"))).toEqual(original)
    const applied = await manageHooks({ ...options, action: "apply", now: () => new Date("2026-01-02T03:04:05Z") })
    expect(applied.backupPath).toContain("backup")
    const file = JSON.parse(await readFile(join(codexHome, "hooks.json"), "utf8"))
    expect(file.hooks.Stop[0].description).toBe("existing")
    expect(JSON.stringify(file)).toContain("'/node with spaces/node'")
    expect(JSON.stringify(file)).toContain("commandWindows")
    for (const event of INSTALLED_HOOK_EVENTS) expect(file.hooks[event].filter((entry: unknown) => JSON.stringify(entry).includes("daemonlet-codex-pet-adapter"))).toHaveLength(1)
    expect((await manageHooks({ ...options, action: "apply" })).changed).toBe(false)
    await manageHooks({ ...options, action: "uninstall" })
    const uninstalled = JSON.parse(await readFile(join(codexHome, "hooks.json"), "utf8"))
    expect(uninstalled.hooks.Stop).toHaveLength(1)
    expect(JSON.stringify(uninstalled)).not.toContain("daemonlet-codex-pet-adapter")
  })

  it("aborts on invalid existing JSON", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "codex-invalid-"))
    directories.push(codexHome)
    await writeFile(join(codexHome, "hooks.json"), "{")
    await expect(manageHooks({ codexHome, projectRoot: "/project", action: "apply" })).rejects.toThrow("invalid hooks.json")
  })

  it("refuses malformed hook structures and leaves uninstall as a no-op when not installed", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "codex-structure-"))
    directories.push(codexHome)
    await writeFile(join(codexHome, "hooks.json"), JSON.stringify({ hooks: { Stop: "unsafe" } }))
    await expect(manageHooks({ codexHome, projectRoot: "/project", action: "apply" })).rejects.toThrow("every hook event")
    await writeFile(join(codexHome, "hooks.json"), "{}\n")
    expect(await manageHooks({ codexHome, projectRoot: "/project", action: "uninstall" })).toMatchObject({ changed: false, after: "{}\n" })
  })
})
