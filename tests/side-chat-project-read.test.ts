import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink, link, rename } from "node:fs/promises"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"
import { ProjectReadService } from "../electron/main/side-chat/ProjectReadService"
import { SideChatService } from "../electron/main/side-chat/SideChatService"
import { compilePersona } from "../electron/main/side-chat/PersonaCompiler"
import { neutralPersona } from "../electron/shared/character-persona"

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "project-read-test-"))); roots.push(root)
  const project = join(root, "project"), state = join(root, "codex")
  await mkdir(project); await mkdir(state)
  await writeFile(join(project, "code.ts"), "first\nsecond\nthird\n")
  return { root, project, state, reader: await ProjectReadService.create(project, state) }
}
describe("explicit project excerpts without a shell", () => {
  it("returns bounded line numbers, read time and a fresh snapshot", async () => {
    const f = await fixture()
    expect(await f.reader.readProjectText("code.ts", 2, 3)).toMatchObject({ path: "code.ts", startLine: 2, endLine: 3, text: "2: second\n3: third\n", truncated: true })
    await writeFile(join(f.project, "code.ts"), "changed\n")
    expect((await f.reader.readProjectText("code.ts", 1, 1)).text).toBe("1: changed\n")
  })
  it.each(["../outside.ts", "/etc/passwd", "dir/../code.ts", ".env", ".env.production", "foo.env", "auth.json", "credentials.json", ".git/config", ".ssh/id_rsa", "dir\\code.ts", "socket.sock", "image.png"])("rejects %s before returning content", async path => {
    const f = await fixture(); await expect(f.reader.readProjectText(path)).rejects.toThrow("READ_ACCESS_DENIED")
  })
  it("rejects symlink files, directory escape, hardlinks and root replacement", async () => {
    const f = await fixture(), outside = join(f.root, "outside.ts")
    await writeFile(outside, "outside-secret")
    await symlink(outside, join(f.project, "linked.ts")); await link(outside, join(f.project, "hard.ts"))
    await symlink(f.root, join(f.project, "escape"))
    for (const path of ["linked.ts", "hard.ts", "escape/outside.ts"]) await expect(f.reader.readProjectText(path)).rejects.toThrow("READ_ACCESS_DENIED")
    await rename(f.project, f.project + "-old"); await mkdir(f.project); await writeFile(join(f.project, "code.ts"), "replaced")
    await expect(f.reader.readProjectText("code.ts")).rejects.toThrow("READ_ACCESS_DENIED")
  })
  it("rejects broad roots, binary data, private keys and oversized files/ranges", async () => {
    const f = await fixture()
    for (const root of [homedir(), "/", f.state, f.root]) await expect(ProjectReadService.create(root, f.state)).rejects.toThrow("READ_ACCESS_DENIED")
    await writeFile(join(f.project, "binary.txt"), Buffer.from([0, 255]))
    // Synthetic header only; never put real credential material in test sources.
    await writeFile(join(f.project, "key.txt"), ["-----BEGIN", "PRIVATE", "KEY-----"].join(" ") + "\nfixture")
    for (const path of ["binary.txt", "key.txt"]) await expect(f.reader.readProjectText(path)).rejects.toThrow("READ_ACCESS_DENIED")
    await writeFile(join(f.project, "big.txt"), "a".repeat(1024 * 1024 + 1))
    await expect(f.reader.readProjectText("big.txt")).rejects.toThrow("READ_LIMIT")
    for (const [start, end] of [[0, 1], [1, 401], [3, 2], [NaN, 3], [500, 500]]) await expect(f.reader.readProjectText("code.ts", start, end)).rejects.toThrow("READ_LIMIT")
    await writeFile(join(f.project, "long.txt"), ("x".repeat(1024) + "\n").repeat(80))
    const value = await f.reader.readProjectText("long.txt")
    expect(Buffer.byteLength(value.text)).toBeLessThanOrEqual(32 * 1024); expect(value.truncated).toBe(true)
  })
  it("keeps excerpts in Main, clears them across parent/policy epochs and rejects late selections", async () => {
    const f = await fixture(), send = vi.fn(async (_text: string) => ({ text: "reply", preview: "", expression: "neutral" as const }))
    const service = new SideChatService(() => ({ isSessionOpen: () => true, onSessionClosed: () => () => {}, open: async () => ({ threadId: "child", lastTurnId: "base", contextAt: 1 }), send, stop: async () => {}, close: async () => {} }))
    service.configure(true, "ko"); service.setConnectionMode("official-same-home")
    service.applyPersona({ id: "gpichan", revision: "fixture", label: "지피쨩", compiled: compilePersona("지피쨩", neutralPersona(), "ko") })
    service.setCandidates([{ threadId: "parent", title: "fixture", cwd: f.project, sourceHome: f.state }], "parent")
    const epoch = service.snapshot().epoch
    await service.attachFile(join(f.project, "code.ts"), 1, 2, epoch)
    expect(JSON.stringify(service.snapshot())).not.toContain("second")
    expect(service.snapshot().attachments?.[0]).toMatchObject({ path: "code.ts", startLine: 1, endLine: 2 })
    const attached = service.snapshot().attachments
    service.setDraft("kept draft")
    service.chooseThread("parent", "new-activity-row")
    expect(service.snapshot()).toMatchObject({ epoch, draft: "kept draft", attachments: attached })
    expect(send).not.toHaveBeenCalled()
    await service.send("explain")
    expect(send.mock.calls[0][0]).toContain("1: first"); expect(service.snapshot().attachments).toEqual([])
    service.reset()
    await expect(service.attachFile(join(f.project, "code.ts"), 1, 2, epoch)).rejects.toThrow("STALE_REQUEST")
    expect(service.snapshot().attachments).toEqual([])
    await service.dispose()
  })
})
