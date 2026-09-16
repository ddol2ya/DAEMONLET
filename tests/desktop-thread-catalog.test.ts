import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, toNamespacedPath } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { readDesktopThreadCatalog, readDesktopThreadCatalogPage } from "../electron/main/control/DesktopThreadCatalog"

const directories: string[] = []
const id = "11111111-1111-4111-8111-111111111111"
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "catalog-titles-")); directories.push(home)
  const path = join(home, "sessions", "2026", "09", "12", `rollout-2026-09-12T00-00-00-${id}.jsonl`)
  const db = new DatabaseSync(join(home, "state_5.sqlite"))
  db.exec("CREATE TABLE threads (id TEXT, rollout_path TEXT, cwd TEXT, title TEXT, source TEXT, updated_at INTEGER, archived INTEGER)")
  db.prepare("INSERT INTO threads VALUES (?,?,?,?,?,?,?)").run(id, path, "/fixture", "SQLite fallback", "exec", 1, 0)
  db.close()
  return { home, index: join(home, "session_index.jsonl") }
}
const line = (name: string, at: string) => JSON.stringify({ id, thread_name: name, updated_at: at })

describe("desktop session display titles", () => {
  it("pages and searches metadata beyond the initial list without treating query text as SQL", async () => {
    const f = await fixture(), db = new DatabaseSync(join(f.home, "state_5.sqlite"))
    for (let n = 0; n < 70; n++) {
      const next = `22222222-2222-4222-8222-${n.toString(16).padStart(12, "0")}`
      const path = join(f.home, "sessions", "2026", "09", "12", `rollout-2026-09-12T00-00-00-${next}.jsonl`)
      db.prepare("INSERT INTO threads VALUES (?,?,?,?,?,?,?)").run(next, path, "/fixture", `New ${n}`, "exec", n + 2, 0)
    }
    db.close()
    expect(await readDesktopThreadCatalog(f.home)).toHaveLength(64)
    expect(await readDesktopThreadCatalogPage(f.home, { offset: 0, query: "" })).toMatchObject({ hasMore: true, items: { length: 64 } })
    expect((await readDesktopThreadCatalog(f.home, { offset: 64, query: "" })).some(row => row.id === id)).toBe(true)
    expect(await readDesktopThreadCatalog(f.home, { offset: 0, query: "SQLite fallback" })).toMatchObject([{ id }])
    expect(await readDesktopThreadCatalog(f.home, { offset: 0, query: "' OR 1=1 --" })).toEqual([])
    await writeFile(f.index, line("찾을 이름", "2026-09-12T01:00:00Z"), { mode: 0o600 })
    expect(await readDesktopThreadCatalog(f.home, { offset: 0, query: "찾을 이름" })).toMatchObject([{ id, title: "찾을 이름" }])
    const changed = new DatabaseSync(join(f.home, "state_5.sqlite"))
    changed.prepare("UPDATE threads SET source='ineligible' WHERE id != ?").run(id); changed.close()
    expect(await readDesktopThreadCatalogPage(f.home, { offset: 0, query: "" })).toEqual({ items: [], hasMore: true })
    expect((await readDesktopThreadCatalogPage(f.home, { offset: 64, query: "" })).items).toMatchObject([{ id }])
  })
  it("uses the visible request for attachment-generated titles while preserving explicit renames", async () => {
    const f = await fixture(), db = new DatabaseSync(join(f.home, "state_5.sqlite"))
    const wrapped = "# Files mentioned by the user:\n\n## reference.md: /tmp/" + "private-attachment/".repeat(20) + "\n\n## My request:\n읽고 작업해줘"
    db.prepare("UPDATE threads SET title=? WHERE id=?").run(wrapped, id)
    expect((await readDesktopThreadCatalog(f.home))[0].title).toBe("읽고 작업해줘")
    db.exec("ALTER TABLE threads ADD COLUMN name TEXT")
    db.prepare("UPDATE threads SET name=? WHERE id=?").run("직접 바꾼 이름", id); db.close()
    expect((await readDesktopThreadCatalog(f.home))[0].title).toBe("직접 바꾼 이름")
  })
  it("includes continued sessions whose rollout filename carries a second UUID", async () => {
    const f = await fixture(), db = new DatabaseSync(join(f.home, "state_5.sqlite"))
    const path = join(f.home, "sessions", "2026", "09", "12", `rollout-2026-09-12T00-00-00-${id}_22222222-2222-4222-8222-222222222222.jsonl`)
    db.prepare("UPDATE threads SET rollout_path=? WHERE id=?").run(path, id); db.close()
    await writeFile(f.index, line("이어진 대화 제목", "2026-09-12T01:00:00Z"), { mode: 0o600 })
    expect(await readDesktopThreadCatalog(f.home)).toMatchObject([{ id, path, title: "이어진 대화 제목" }])
  })
  it("uses the latest renamed title from the session index and tolerates a partial final record", async () => {
    const f = await fixture()
    await writeFile(f.index, [line("새 세션 제목", "2026-09-12T01:00:00Z"), line("오래된 이름", "2026-09-11T01:00:00Z"), "{unfinished"].join("\n"), { mode: 0o600 })
    expect((await readDesktopThreadCatalog(f.home))[0].title).toBe("새 세션 제목")
  })
  it.skipIf(process.platform === "win32")("falls back for missing, writable, or linked title indexes", async () => {
    const f = await fixture()
    expect((await readDesktopThreadCatalog(f.home))[0].title).toBe("SQLite fallback")
    await writeFile(f.index, line("UNTRUSTED_TITLE", "2026-09-12T01:00:00Z")); await chmod(f.index, 0o666)
    expect((await readDesktopThreadCatalog(f.home))[0].title).toBe("SQLite fallback")
    await rm(f.index)
    const target = join(f.home, "linked-titles"); await writeFile(target, line("LINKED_TITLE", "2026-09-12T01:00:00Z"), { mode: 0o600 }); await symlink(target, f.index)
    expect((await readDesktopThreadCatalog(f.home))[0].title).toBe("SQLite fallback")
  })
  it.runIf(process.platform === "win32")("reads Windows metadata despite synthetic Unix permission bits", async () => {
    const f = await fixture()
    expect((await readDesktopThreadCatalog(f.home))[0].title).toBe("SQLite fallback")
    await writeFile(f.index, line("Windows 대화", "2026-09-12T01:00:00Z"))
    expect((await readDesktopThreadCatalog(f.home))[0].title).toBe("Windows 대화")
  })
  it.runIf(process.platform === "win32")("discovers Desktop tasks stored with extended-length rollout paths", async () => {
    const f = await fixture(), db = new DatabaseSync(join(f.home, "state_5.sqlite"))
    const path = toNamespacedPath(join(f.home, "sessions", "2026", "09", "12", `rollout-2026-09-12T00-00-00-${id}.jsonl`))
    db.prepare("UPDATE threads SET rollout_path=?, source=? WHERE id=?").run(path, "vscode", id); db.close()
    await writeFile(f.index, line("Windows sleep test", "2026-09-12T01:00:00Z"))
    expect(await readDesktopThreadCatalog(f.home)).toMatchObject([{ id, path, title: "Windows sleep test" }])
    expect(await readDesktopThreadCatalog(toNamespacedPath(f.home))).toMatchObject([{ id, path }])
  })
})
