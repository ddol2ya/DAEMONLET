import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, readFile, writeFile, rm, stat, readdir, symlink, chmod, mkdir, link, open, rename } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { ActivityHistoryStore, validateActivityHistory } from "../electron/main/activity/ActivityHistoryStore"
import { ActivityStore } from "../electron/main/activity/ActivityStore"

const directories: string[] = []
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return { ...actual, open: vi.fn(actual.open) }
})
const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
afterEach(async () => { await Promise.all(directories.splice(0).map(d => rm(d, { recursive: true, force: true }))) })
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "activity-history-test-")); directories.push(directory)
  const history = new ActivityHistoryStore(directory), store = new ActivityStore(() => 1000)
  store.accept({ protocolVersion: 1, source: "codex-adapter", sourceInstanceId: "one", sessionId: "session", messageId: "event", sequence: 1, sentAt: 1000, frameType: "event", payload: { type: "run.failed", runId: "private-wire-run", message: "private failure" } })
  return { directory, history, data: store.exportHistory() }
}

describe("private atomic activity history", () => {
  it("round-trips bounded data and enforces private Unix directory/file modes", async () => {
    const { history, data } = await fixture()
    await history.save(data)
    expect(await history.load()).toEqual({ data, issue: null })
    if (process.platform !== "win32") {
      expect((await stat(history.directory)).mode & 0o777).toBe(0o700)
      expect((await stat(history.path)).mode & 0o777).toBe(0o600)
      await chmod(history.directory, 0o755); await chmod(history.path, 0o644)
      await history.load()
      expect((await stat(history.directory)).mode & 0o777).toBe(0o700)
      expect((await stat(history.path)).mode & 0o777).toBe(0o600)
    }
    expect(await readdir(history.directory)).toEqual(["history.json"])
    expect(await readFile(history.path, "utf8")).not.toContain("private")
  })

  it("quarantines malformed and oversized files in one slot and continues", async () => {
    const { history, data } = await fixture()
    await history.save(data)
    await writeFile(history.path, "{broken", { mode: 0o600 })
    expect(await history.load()).toEqual({ data: null, issue: "corrupt" })
    expect(await readFile(join(history.directory, "history.corrupt.json"), "utf8")).toBe("{broken")
    await history.save(data)
    await writeFile(history.path, "x".repeat(1024 * 1024 + 1))
    expect((await history.load()).issue).toBe("corrupt")
    expect(await readdir(history.directory)).toEqual(["history.corrupt.json"])
    await history.save(data)
    expect((await history.load()).data).toEqual(data)
  })

  it("rejects excess fields, duplicate keys/identities and contradictory states", async () => {
    const { data } = await fixture()
    expect(validateActivityHistory({ ...data, prompt: "CANARY" })).toBeNull()
    for (const patch of [{ label: "CANARY" }, { key: "raw-run" }, { category: "private tool" }, { revision: -1 }, { state: "success" }, { endedAt: null }, { confidence: "authoritative" }]) {
      expect(validateActivityHistory({ ...data, records: [{ ...data.records[0], ...patch }] })).toBeNull()
    }
    expect(validateActivityHistory({ ...data, records: [data.records[0], data.records[0]] })).toBeNull()
    expect(validateActivityHistory({ ...data, tombstones: [{ key: data.records[0].key, expiresAt: 3000 }] })).toBeNull()
    expect(validateActivityHistory({ ...data, nextId: 1 })).toBeNull()
  })

  it("refuses symlink files and directories and never follows them", async () => {
    const { directory, history, data } = await fixture()
    const target = join(directory, "foreign")
    await writeFile(target, "UNCHANGED")
    await mkdir(history.directory)
    await symlink(target, history.path)
    expect((await history.load()).issue).toBe("error")
    expect(await readFile(target, "utf8")).toBe("UNCHANGED")
    await rm(history.directory, { recursive: true })
    const foreignDir = join(directory, "foreign-dir")
    await mkdir(foreignDir)
    await symlink(foreignDir, history.directory, process.platform === "win32" ? "junction" : "dir")
    await expect(history.save(data)).rejects.toThrow()
    expect(await readdir(foreignDir)).toEqual([])
  })

  it.each(["symlink", "hardlink"])("rejects a %s to valid foreign history without reading or quarantining it", async kind => {
    const { directory, history, data } = await fixture()
    const target = join(directory, "foreign-valid.json"), content = JSON.stringify(data)
    await writeFile(target, content)
    await mkdir(history.directory)
    if (kind === "symlink") await symlink(target, history.path)
    else await link(target, history.path)
    const before = await stat(target)
    expect(await history.load()).toEqual({ data: null, issue: "error" })
    expect(await readFile(target, "utf8")).toBe(content)
    expect((await stat(target)).mode).toBe(before.mode)
    expect(await readdir(history.directory)).toEqual(["history.json"])
  })

  it("rejects a file replaced between name inspection and open", async () => {
    const { directory, history, data } = await fixture()
    await history.save(data)
    const replacement = join(directory, "replacement.json")
    await writeFile(replacement, JSON.stringify(data))
    vi.mocked(open).mockImplementationOnce(async (...args: Parameters<typeof open>) => {
      await rename(history.path, join(directory, "old-history.json"))
      await rename(replacement, history.path)
      return actualFs.open(...args)
    })
    expect(await history.load()).toEqual({ data: null, issue: "error" })
    expect(await readdir(history.directory)).toEqual(["history.json"])
  })

  it("keeps the last committed file when replacement fails and removes temporary writes", async () => {
    const { history, data } = await fixture()
    await history.save(data)
    const before = await readFile(history.path, "utf8")
    // An isolated directory at the commit target forces a deterministic rename error.
    await rm(history.path); await mkdir(history.path)
    await expect(history.save(data)).rejects.toThrow()
    expect((await readdir(history.directory)).some(name => name.startsWith("history.tmp"))).toBe(false)
    await rm(history.path, { recursive: true }); await writeFile(history.path, before, { mode: 0o600 })
    expect((await history.load()).data).toEqual(data)
  })
})
