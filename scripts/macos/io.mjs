import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { createReadStream } from "node:fs"
import { chmod, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm } from "node:fs/promises"
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path"
import { isMachOMagic } from "./binary.mjs"

export const repository = resolve(import.meta.dirname, "../..")

export async function privateDirectory(path, { fresh = false } = {}) {
  if (!isAbsolute(path)) throw new Error("An absolute private output path is required.")
  if (fresh) await mkdir(path, { mode: 0o700 })
  else await mkdir(path, { recursive: true, mode: 0o700 })
  if ((await lstat(path)).isSymbolicLink()) throw new Error("Private output directory cannot be a symlink.")
  const canonical = await realpath(path)
  const checkout = await realpath(repository)
  if (within(checkout, canonical) || within(canonical, checkout)) throw new Error("Candidate/evidence root must be outside the checkout.")
  await chmod(canonical, 0o700)
  return canonical
}

export function within(parent, child) {
  const path = relative(parent, child)
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))
}

export async function writeJSON(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`
  const file = await open(temp, "wx", 0o600)
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`)
    await file.sync()
    await file.close()
    await rename(temp, path)
  } finally {
    await file.close().catch(() => {})
    // Only this invocation's exclusively created temporary file may be removed.
    await rm(temp, { force: true }).catch(() => {})
  }
}

export async function readJSON(path) {
  const info = await lstat(path)
  if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new Error("Invalid or oversized private state file.")
  return JSON.parse(await readFile(path, "utf8"))
}

export async function withLock(root, operation) {
  const path = join(root, ".operation.lock")
  let lock
  try { lock = await open(path, "wx", 0o600) }
  catch { throw new Error("Candidate is locked. Inspect the owner before recovering a stale lock; concurrent mutations are prohibited.") }
  try { await lock.writeFile(`${process.pid}\n`); return await operation() }
  finally { await lock.close(); await rm(path) }
}

export async function hashFile(path, algorithm = "sha256") {
  const hash = createHash(algorithm)
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest("hex")
}

export function hashObject(value) {
  return createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex")
}

export async function inventory(bundle) {
  const root = await realpath(bundle)
  const entries = []
  async function walk(directory) {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name)
      const info = await lstat(path)
      const entry = { path: relative(root, path), mode: info.mode & 0o777 }
      if (info.isSymbolicLink()) {
        if (!within(root, await realpath(path))) throw new Error("Bundle contains an escaping symlink.")
        entries.push({ ...entry, type: "symlink", target: await readlink(path) })
      } else if (info.isDirectory()) {
        entries.push({ ...entry, type: "directory" })
        await walk(path)
      } else if (info.isFile()) {
        const handle = await open(path, "r")
        const magic = Buffer.alloc(4)
        try { await handle.read(magic, 0, 4, 0) } finally { await handle.close() }
        entries.push({ ...entry, type: "file", bytes: info.size, sha256: await hashFile(path),
          machO: isMachOMagic(magic) })
      } else throw new Error("Bundle contains an unsupported filesystem entry.")
    }
  }
  await walk(root)
  return { entries, sha256: hashObject(entries) }
}

// Never use shell command strings or print captured diagnostics: signer metadata and
// notary responses belong in the private evidence directory. Cancellation also stops
// descendants, including an in-flight build or upload; uncertain uploads stay pending.
/**
 * @param {string} file
 * @param {string[]} args
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, input?: string | Buffer,
 * timeoutMs?: number, maxBytes?: number, logPath?: string, allowFailure?: boolean,
 * signal?: AbortSignal}} [options]
 */
export async function run(file, args, {
  cwd = repository, env = process.env, input, timeoutMs = 120_000,
  maxBytes = 8 * 1024 * 1024, logPath, allowFailure = false, signal,
} = {}) {
  const result = await new Promise((resolveRun, rejectRun) => {
    const child = spawn(file, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" })
    const stdout = [], stderr = []
    let bytes = 0, stopped = null, killTimer
    const kill = (kind) => {
      try { process.platform === "win32" ? child.kill(kind) : process.kill(-child.pid, kind) }
      catch (error) { if (error.code !== "ESRCH") child.kill(kind) }
    }
    const stop = (reason) => {
      if (stopped) return
      stopped = reason
      kill("SIGTERM")
      killTimer = setTimeout(() => kill("SIGKILL"), 1500)
    }
    const abort = () => stop("cancelled")
    const interrupt = () => stop("cancelled")
    const timeout = setTimeout(() => stop("timeout"), timeoutMs)
    signal?.addEventListener("abort", abort, { once: true })
    process.once("SIGINT", interrupt)
    process.once("SIGTERM", interrupt)
    if (signal?.aborted) abort()
    for (const [stream, output] of [[child.stdout, stdout], [child.stderr, stderr]]) {
      stream.on("data", (chunk) => {
        bytes += chunk.length
        if (bytes > maxBytes) stop("output-limit")
        else output.push(chunk)
      })
    }
    child.stdin.on("error", () => {})
    child.stdin.end(input)
    const cleanup = () => {
      clearTimeout(timeout); clearTimeout(killTimer)
      signal?.removeEventListener("abort", abort)
      process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt)
    }
    child.on("error", () => { cleanup(); rejectRun(new Error(`Unable to start ${basename(file)}.`)) })
    child.on("close", (code, terminationSignal) => {
      cleanup()
      resolveRun({ code, signal: terminationSignal, stopped, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() })
    })
  })
  if (logPath) await writeJSON(logPath, result)
  if (result.stopped || (!allowFailure && result.code !== 0)) {
    throw new Error(`${basename(file)} failed (${result.stopped ?? result.signal ?? result.code}).${logPath ? " Inspect its private diagnostic log." : ""}`)
  }
  return result
}
