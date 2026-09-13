import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { inventory, run, withLock, writeJSON } from "../scripts/macos/io.mjs"
import { isSigningTarget } from "../scripts/macos/binary.mjs"

const roots: string[] = []
async function temp() { const root = await mkdtemp(join(tmpdir(), "macos-candidate-test-")); roots.push(root); return root }
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

it("signs actual Mach-O code and bundles without signing generic binary resources", async () => {
  const root = await temp()
  for (const name of ["Pet.app", "Electron.framework", "Resources"]) await mkdir(join(root, name))
  for (const name of ["locale.pak", "image.png", "character.psd", "app.asar"]) {
    const path = join(root, name)
    await writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 0xff]))
    expect(isSigningTarget(path)).toBe(false)
  }
  const code = join(root, "executable without extension")
  await writeFile(code, Buffer.from("cffaedfe00000000", "hex"))
  await symlink("executable without extension", join(root, "alias"))
  expect(isSigningTarget(code)).toBe(true)
  expect(isSigningTarget(join(root, "Pet.app"))).toBe(true)
  expect(isSigningTarget(join(root, "Electron.framework"))).toBe(true)
  expect(isSigningTarget(join(root, "Resources"))).toBe(false)
  expect(isSigningTarget(join(root, "alias"))).toBe(false)
})

it("hashes content and permissions and rejects a symlink outside the bundle", async () => {
  const root = await temp()
  const app = join(root, "앱 with spaces.app")
  await mkdir(app)
  await writeFile(join(app, "binary"), Buffer.from("cffaedfe00000000", "hex"))
  await symlink("binary", join(app, "alias"))
  const first = await inventory(app)
  expect(first.entries).toEqual(expect.arrayContaining([expect.objectContaining({ path: "binary", machO: true }), expect.objectContaining({ path: "alias", target: "binary" })]))
  await writeFile(join(app, "binary"), "changed")
  expect((await inventory(app)).sha256).not.toBe(first.sha256)
  await symlink(root, join(app, "escape"))
  await expect(inventory(app)).rejects.toThrow("escaping symlink")
})

it("prevents concurrent candidate mutations and releases its lock on failure", async () => {
  const root = await temp()
  await expect(withLock(root, async () => {
    await expect(withLock(root, async () => {})).rejects.toThrow("locked")
    throw new Error("operation failed")
  })).rejects.toThrow("operation failed")
  await expect(withLock(root, async () => "recovered")).resolves.toBe("recovered")
})

it("can retry a failed JSON rename without deleting a pre-existing temporary file", async () => {
  const root = await temp()
  const target = join(root, "state.json")
  const olderTemp = `${target}.${process.pid}.tmp`
  await writeFile(olderTemp, "preserve an earlier interrupted write")
  await mkdir(target)
  await writeFile(join(target, "sentinel"), "destination is deliberately not a file")
  await expect(writeJSON(target, { status: "prepared" })).rejects.toThrow()
  expect(await readFile(join(target, "sentinel"), "utf8")).toBe("destination is deliberately not a file")
  expect(await readFile(olderTemp, "utf8")).toBe("preserve an earlier interrupted write")
  expect((await readdir(root)).sort()).toEqual(["state.json", `state.json.${process.pid}.tmp`].sort())
  await rm(target, { recursive: true }) // Remove only this test's injected filesystem fault.
  await writeJSON(target, { status: "prepared" })
  expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ status: "prepared" })
  expect(await readFile(olderTemp, "utf8")).toBe("preserve an earlier interrupted write")
})

it("passes paths and metacharacters as exact arguments without invoking a shell", async () => {
  const text = "한글 path with spaces; `no-execution` $(no-execution)"
  const result = await run(process.execPath, ["-e", "process.stdout.write(process.argv[1])", text])
  expect(result.stdout).toBe(text)
})

it("bounds output and runtime and keeps subprocess diagnostics in private logs", async () => {
  const root = await temp()
  const log = join(root, "private.json")
  await expect(run(process.execPath, ["-e", "process.stderr.write('PRIVATE_DIAGNOSTIC');process.exit(3)"], { logPath: log })).rejects.toThrow("private diagnostic")
  expect(JSON.parse(await readFile(log, "utf8")).stderr).toBe("PRIVATE_DIAGNOSTIC")
  await expect(run(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 100 })).rejects.toThrow("timeout")
  await expect(run(process.execPath, ["-e", "process.stdout.write('x'.repeat(100000))"], { maxBytes: 1024 })).rejects.toThrow("output-limit")
  const abort = new AbortController()
  const operation = run(process.execPath, ["-e", "setInterval(()=>{},1000)"], { signal: abort.signal })
  abort.abort()
  await expect(operation).rejects.toThrow("cancelled")
})
