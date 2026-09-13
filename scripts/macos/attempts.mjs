import { randomUUID } from "node:crypto"
import { lstat, mkdir, readdir, realpath } from "node:fs/promises"
import { join } from "node:path"
import { hashObject, readJSON, writeJSON } from "./io.mjs"

const idPattern = /^(prepare|archive)-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const stamp = () => new Date().toISOString()

export async function optionalJSON(path) {
  try { return await readJSON(path) }
  catch (error) { if (error.code === "ENOENT") return null; throw error }
}

export async function ownedDirectory(path, { create = false } = {}) {
  if (create) {
    try { await mkdir(path, { mode: 0o700 }) }
    catch (error) { if (error.code !== "EEXIST") throw error }
  }
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path
    || process.getuid && info.uid !== process.getuid()) throw new Error("Candidate directory must be owned, canonical and not a symlink.")
  return path
}

export async function attemptDirectory(root, id, operation) {
  if (!idPattern.test(id ?? "") || !id.startsWith(`${operation}-`)) throw new Error("Invalid local attempt reference.")
  await ownedDirectory(join(root, "attempts"))
  return ownedDirectory(join(root, "attempts", id))
}

export async function linkedAttempt(root, manifest, id, operation) {
  const directory = await attemptDirectory(root, id, operation)
  const record = await readJSON(join(directory, "attempt.json"))
  if (record.schemaVersion !== 1 || record.id !== id || record.operation !== operation
    || record.candidateFingerprint !== hashObject(manifest) || record.status !== "validated") {
    throw new Error("State does not reference a validated attempt for this candidate.")
  }
  return { directory, record }
}

/**
 * Every invocation creates a new directory; previous output and journals are never
 * modified. Only the canonical submission state's attempt pointer commits a result.
 * A journal marked 'validated' alone may be an interrupted state-write, not a commit.
 * @param {string} root
 * @param {object} manifest
 * @param {"prepare" | "archive"} operation
 * @param {{mode?: string, retryReason?: string, inputs?: object}} options
 * @param {(attempt: any) => Promise<any>} perform
 */
export async function localAttempt(root, manifest, operation, { mode = "create", retryReason, inputs = {} }, perform) {
  if (retryReason !== undefined && (typeof retryReason !== "string" || !retryReason.trim() || retryReason.length > 512 || /[\0\r\n]/.test(retryReason))) {
    throw new Error("Retry reason must be a nonempty single line of at most 512 characters.")
  }
  const parent = await ownedDirectory(join(root, "attempts"), { create: true })
  const previous = [], unrecognized = []
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    if (!idPattern.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) { unrecognized.push(entry.name); continue }
    // Orphaned/unreadable attempt output is retained, never used to authorize a
    // submission or recover a result. This also handles death before the first journal.
    let record
    try { record = await readJSON(join(parent, entry.name, "attempt.json")) }
    catch { unrecognized.push(entry.name); continue }
    if (record.schemaVersion !== 1 || record.id !== entry.name || !["prepare", "archive"].includes(record.operation)) { unrecognized.push(entry.name); continue }
    if (record.candidateFingerprint !== hashObject(manifest)) throw new Error("Existing attempt belongs to a different candidate; use a new candidate root.")
    previous.push({ id: record.id, status: record.status, stage: record.stage })
  }
  const id = `${operation}-${randomUUID()}`
  const directory = join(parent, id)
  await mkdir(directory, { mode: 0o700 })
  const path = join(directory, "attempt.json")
  const record = { schemaVersion: 1, id, operation, mode, candidateFingerprint: hashObject(manifest),
    sourceCommit: manifest.sourceCommit, startedAt: stamp(), trigger: "explicit-invocation", retryReason: retryReason ?? null,
    previousAttempts: previous, preservedUnrecognizedEntries: unrecognized, inputs, status: "running", stage: "created" }
  const attempt = {
    id, directory,
    async stage(stage) { record.stage = stage; await writeJSON(path, record) },
    async validated(result) { Object.assign(record, { status: "validated", result, validatedAt: stamp() }); await writeJSON(path, record) },
  }
  try {
    await writeJSON(path, record)
    return await perform(attempt)
  } catch (error) {
    Object.assign(record, { status: "failed", failedAt: stamp(), error: { name: error.name, code: error.code ?? null, message: String(error.message).slice(0,4096) } })
    // Disk failure may prevent even a journal write. Retain its last completed
    // stage and orphaned output; never replace the original failure with that error.
    await writeJSON(path, record).catch(() => {})
    error.message += `\nLocal attempt: attempts/${id}/attempt.json (stage: ${record.stage}).`
    throw error
  }
}
