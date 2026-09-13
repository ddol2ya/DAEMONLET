/**
 * PR #13 regression proposal for interrupted local prepare/archive attempts.
 * Place in tests/macos-candidate-retry.test.ts.
 *
 * Uses real temporary files, state IO and candidate locks. macOS verification,
 * compression and Hook subprocesses are fixture doubles; no Apple upload,
 * signing, real ZIP creation, or user configuration changes occur.
 *
 * These expectations intentionally fail on review HEAD 19cb8993.
 * If recovery becomes an explicit API, adapt the retry invocation to that API,
 * while retaining the safety assertions and the original failed-attempt record.
 */
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ run: vi.fn(), verify: vi.fn(), failStateWrite: null as string | null }))
vi.mock("../scripts/macos/io.mjs", async (original) => {
  const actual = await original<typeof import("../scripts/macos/io.mjs")>()
  return { ...actual, run: mocks.run, writeJSON: async (path: string, value: unknown) => {
    if (path === mocks.failStateWrite) { mocks.failStateWrite = null; throw new Error("fixture state commit unavailable") }
    return actual.writeJSON(path, value)
  } }
})
vi.mock("../scripts/macos/verify.mjs", async (original) => ({
  ...await original<typeof import("../scripts/macos/verify.mjs")>(),
  verifyApp: mocks.verify,
}))

import { hashFile, inventory, readJSON, writeJSON } from "../scripts/macos/io.mjs"
import { createFinalArchive, prepareSubmission, refreshStatus, submitCandidate } from "../scripts/macos/notarize.mjs"

const roots: string[] = []
const stateName = "private-submission-state.json"
const appName = "Daemonlet for Codex.app"

beforeEach(() => { mocks.run.mockReset(); mocks.verify.mockReset(); mocks.failStateWrite = null })
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(stage: "signed" | "notarized" = "notarized") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "macos-retry-regression-")))
  roots.push(root)
  const app = join(root, "signed", appName)
  await mkdir(join(app, "Contents"), { recursive: true })
  await mkdir(join(root, "evidence-private"))
  const payloadPath = join(app, "Contents", "fixture-payload")
  await writeFile(payloadPath, "unchanged-signed-payload-fixture")
  const manifest = {
    schemaVersion: 1, source: {sourceCommit: "a".repeat(40), sourceTreeSha256: "d".repeat(64), workingTreeHasChanges: false}, sourceCommit: "a".repeat(40), app,
    version: "0.2.0", architecture: "arm64",
    signer: { team: "ABCDEFGHIJ", fingerprint: "A".repeat(40) },
    payload: { "app.asar": "b".repeat(64) }, signedCode: [],
    inventory: { entries: [], sha256: "c".repeat(64) },
  }
  await writeJSON(join(root, "private-manifest.json"), manifest)
  let originalState: Record<string, unknown> | null = null
  const submissionPath = join(root, "notarization", "submission.zip")
  if (stage === "notarized") {
    await mkdir(join(root, "notarization"))
    await writeFile(submissionPath, "already-approved-submission-fixture")
    originalState = {
      schemaVersion: 1, sourceCommit: manifest.sourceCommit,
      profile: "fixture-profile", status: "notarized-candidate", appleStatus: "Accepted",
      submissionId: "11111111-2222-3333-4444-555555555555",
      submissionAttemptedAt: "2026-09-07T00:00:00Z",
      submission: {
        path: submissionPath, sha256: await hashFile(submissionPath),
        bytes: Buffer.byteLength("already-approved-submission-fixture"),
      },
    }
    await writeJSON(join(root, stateName), originalState)
    await writeJSON(join(root, "private-stapled-manifest.json"), manifest)
  }
  mocks.verify.mockImplementation(async (path: string) => ({ ...manifest, app: path }))
  return { root, app, manifest, originalState, payloadPath, submissionPath }
}

function installProcessDouble(app: string, failOnce?: "host" | "compression") {
  let injected = false
  let hostCalls = 0
  const execute = async (file: string, args: string[]) => {
    // No local archive recovery is allowed to re-upload, re-sign or re-staple.
    if (file === "/usr/bin/xcrun" || file === "/usr/bin/codesign") {
      throw new Error("Unexpected Apple/signing operation during local retry")
    }
    if (file === "/usr/bin/ditto") {
      if (args.includes("-c")) {
        if (failOnce === "compression" && !injected) {
          injected = true
          throw new Error("fixture one-time compression failure")
        }
        await writeFile(args[args.length - 1], "local-archive-fixture")
      } else if (args.includes("-x")) {
        await cp(app, join(args[args.length - 1], appName), { recursive: true })
      } else throw new Error("Unexpected fixture ditto operation")
    } else if (args.some(arg => arg.endsWith("hook-host-proof.ts"))) {
      hostCalls++
      if (failOnce === "host" && !injected) {
        injected = true
        throw new Error("fixture one-time host timeout")
      }
    } else throw new Error("Unexpected fixture subprocess")
    return { code: 0, stdout: "", stderr: "", stopped: null, signal: null }
  }
  mocks.run.mockImplementation(execute)
  return { hostCalls: () => hostCalls }
}

async function attempts(root: string) {
  const parent = join(root, "attempts")
  const entries = (await readdir(parent)).filter(name => /^(prepare|archive)-/.test(name))
  return Promise.all(entries.map(async id => ({ id, directory: join(parent, id), record: await readJSON(join(parent, id, "attempt.json")) })))
}

it.each(["host", "compression"] as const)(
  "can recover a local %s failure without changing the accepted candidate or re-uploading",
  async failure => {
    const f = await fixture()
    const originalPayload = await readFile(f.payloadPath)
    const originalSubmission = await readFile(f.submissionPath)
    const process = installProcessDouble(f.app, failure)
    await expect(createFinalArchive(f.root)).rejects.toThrow("fixture one-time")
    const failedState = await readJSON(join(f.root, stateName))
    expect(failedState.status).toBe("notarized-candidate")
    expect(failedState.final).toBeUndefined()
    const [firstAttempt] = await attempts(f.root)
    expect(firstAttempt.record).toMatchObject({ status: "failed", stage: failure === "host" ? "verify-hook" : "compress-final" })
    const failedOutput = await inventory(firstAttempt.directory)

    // The old implementation fails here with EEXIST before repeating validation.
    const retry = await createFinalArchive(f.root)
    expect(retry.state.status).toBe("verified-archive")
    expect(retry.state.submission).toEqual(f.originalState!.submission)
    expect(retry.state.submissionId).toBe(f.originalState!.submissionId)
    expect(await readFile(f.payloadPath)).toEqual(originalPayload)
    expect(await readFile(f.submissionPath)).toEqual(originalSubmission)
    expect(process.hostCalls()).toBe(failure === "host" ? 2 : 1)
    expect(mocks.run.mock.calls.some(([file]) => file === "/usr/bin/xcrun")).toBe(false)
    expect((await inventory(firstAttempt.directory)).sha256).toBe(failedOutput.sha256)
    expect(retry.state.archiveAttempt).not.toBe(firstAttempt.id)
    expect(await attempts(f.root)).toHaveLength(2)
  },
)

it("revalidates a fresh extraction after a transient verification failure", async () => {
  const f = await fixture()
  installProcessDouble(f.app)
  mocks.verify.mockResolvedValueOnce(f.manifest)
  mocks.verify.mockRejectedValueOnce(new Error("fixture transient extraction verification failure"))
  await expect(createFinalArchive(f.root)).rejects.toThrow("fixture transient")
  const [failed] = await attempts(f.root)
  expect(failed.record).toMatchObject({ status: "failed", stage: "verify-extracted" })
  const failedOutput = await inventory(failed.directory)
  expect((await readJSON(join(f.root, stateName))).status).toBe("notarized-candidate")
  const retry = await createFinalArchive(f.root)
  expect(retry.state.status).toBe("verified-archive")
  expect(retry.state.submissionId).toBe(f.originalState!.submissionId)
  expect((await inventory(failed.directory)).sha256).toBe(failedOutput.sha256)
})

it("can prepare again after a failed pre-upload check, without automatically submitting", async () => {
  const f = await fixture("signed")
  installProcessDouble(f.app)
  const originalPayload = await readFile(f.payloadPath)
  mocks.verify.mockRejectedValueOnce(new Error("fixture temporary verification unavailable"))
  await expect(prepareSubmission(f.root, "fixture-profile")).rejects.toThrow("fixture temporary")
  const [failed] = await attempts(f.root)
  expect(failed.record).toMatchObject({ status: "failed", stage: "verify-candidate" })
  const failedOutput = await inventory(failed.directory)
  expect(mocks.run).not.toHaveBeenCalled()
  const retry = await prepareSubmission(f.root, "fixture-profile")
  expect(retry.state.status).toBe("prepared")
  expect(retry.state.submissionId).toBeUndefined()
  expect(retry.state.submissionAttemptedAt).toBeUndefined()
  expect(await readFile(f.payloadPath)).toEqual(originalPayload)
  expect(mocks.run.mock.calls.some(([file]) => file === "/usr/bin/xcrun")).toBe(false)
  expect((await inventory(failed.directory)).sha256).toBe(failedOutput.sha256)
})

it("revalidates a prepared ZIP without changing its bytes, approval hash, profile or state", async () => {
  const f = await fixture("signed")
  installProcessDouble(f.app)
  const prepared = await prepareSubmission(f.root, "fixture-profile")
  const state = { ...prepared.state, approvedSha256: prepared.state.submission.sha256 }
  await writeJSON(join(f.root, stateName), state)
  const bytes = await readFile(join(f.root, stateName))
  const zip = await readFile(state.submission.path)
  const verifiedBefore = mocks.verify.mock.calls.length
  const repeated = await prepareSubmission(f.root, "fixture-profile", { retryReason: "Verify the already prepared archive" })
  expect(repeated.state).toEqual(state)
  expect(mocks.verify.mock.calls.length).toBeGreaterThan(verifiedBefore)
  expect(mocks.run).toHaveBeenCalledTimes(1) // Initial compression only.
  expect(await readFile(state.submission.path)).toEqual(zip)
  expect(await readFile(join(f.root, stateName))).toEqual(bytes)
  expect((await attempts(f.root)).some(({ record }) => record.mode === "revalidate-frozen" && record.retryReason === "Verify the already prepared archive")).toBe(true)
  await expect(prepareSubmission(f.root, "different-profile")).rejects.toThrow("profile is frozen")
  expect(await readFile(join(f.root, stateName))).toEqual(bytes)
})

it.each(["Submitted", "submission-uncertain", "In Progress", "Accepted", "notarized-candidate", "verified-archive", "Invalid", "Rejected"])(
  "never resets %s or changes a submitted ZIP while preparing locally", async status => {
    const f = await fixture()
    const state = { ...f.originalState!, status }
    await writeJSON(join(f.root, stateName), state)
    const before = await readFile(join(f.root, stateName))
    const submission = await readFile(f.submissionPath)
    await expect(prepareSubmission(f.root, "fixture-profile")).rejects.toThrow("already attempted")
    expect(await readFile(join(f.root, stateName))).toEqual(before)
    expect(await readFile(f.submissionPath)).toEqual(submission)
    expect(mocks.run).not.toHaveBeenCalled()
    expect(mocks.verify).not.toHaveBeenCalled()
  },
)

it.each(["prepare", "archive"] as const)("retries a %s state commit failure with a fresh attempt and preserves its first result", async operation => {
  const f = await fixture(operation === "prepare" ? "signed" : "notarized")
  const process = installProcessDouble(f.app)
  const before = operation === "archive" ? await readFile(join(f.root, stateName)) : null
  mocks.failStateWrite = join(f.root, stateName)
  const execute = (retryReason?: string) => operation === "prepare"
    ? prepareSubmission(f.root, "fixture-profile", { retryReason }) : createFinalArchive(f.root, { retryReason })
  await expect(execute()).rejects.toThrow("fixture state commit unavailable")
  const [failed] = await attempts(f.root)
  expect(failed.record).toMatchObject({ status: "failed", stage: "commit-state" })
  expect(failed.record.result).toBeDefined()
  const failedOutput = await inventory(failed.directory)
  if (before) expect(await readFile(join(f.root, stateName))).toEqual(before)
  else await expect(readFile(join(f.root, stateName))).rejects.toMatchObject({ code: "ENOENT" })
  const retry = await execute("State storage restored; operator requested a new attempt")
  expect(retry.state.status).toBe(operation === "prepare" ? "prepared" : "verified-archive")
  expect((await inventory(failed.directory)).sha256).toBe(failedOutput.sha256)
  expect(await attempts(f.root)).toHaveLength(2)
  if (operation === "archive") {
    expect(retry.state.submission).toEqual(f.originalState!.submission)
    expect(retry.state.submissionId).toBe(f.originalState!.submissionId)
    expect(process.hostCalls()).toBe(2)
  }
})

it("rejects two concurrent archive requests and revalidates a finished ZIP without recreating it", async () => {
  const f = await fixture()
  const process = installProcessDouble(f.app)
  let unblock!: () => void
  let entered!: () => void
  const waiting = new Promise<void>(done => { entered = done })
  const blocked = new Promise<void>(done => { unblock = done })
  mocks.verify.mockImplementationOnce(async () => { entered(); await blocked; return f.manifest })
  const first = createFinalArchive(f.root)
  await waiting
  try { await expect(createFinalArchive(f.root)).rejects.toThrow("locked") }
  finally { unblock() }
  const complete = await first
  expect(await attempts(f.root)).toHaveLength(1)
  const originalState = await readFile(join(f.root, stateName))
  const originalZip = await readFile(complete.state.final.path)
  const originalAttempt = (await attempts(f.root))[0]
  const originalOutput = await inventory(originalAttempt.directory)
  const repeated = await createFinalArchive(f.root, { retryReason: "Explicit verification of the same finished ZIP" })
  expect(repeated.state).toEqual(complete.state)
  expect(await readFile(join(f.root, stateName))).toEqual(originalState)
  expect(await readFile(complete.state.final.path)).toEqual(originalZip)
  expect((await inventory(originalAttempt.directory)).sha256).toBe(originalOutput.sha256)
  expect(process.hostCalls()).toBe(2)
  expect(mocks.run.mock.calls.filter(([, args]) => args.includes("-c"))).toHaveLength(1)
  const extractions = mocks.run.mock.calls.filter(([, args]) => args.includes("-x")).map(([, args]) => args.at(-1))
  expect(new Set(extractions).size).toBe(2)
})

it("retains historical success but reports a later verification failure without changing verified bytes", async () => {
  const f = await fixture()
  installProcessDouble(f.app)
  const complete = await createFinalArchive(f.root)
  const stateBefore = await readFile(join(f.root, stateName))
  const zipBefore = await readFile(complete.state.final.path)
  mocks.run.mockClear()
  installProcessDouble(f.app, "host")
  await expect(createFinalArchive(f.root)).rejects.toThrow("fixture one-time host timeout")
  expect(await readFile(join(f.root, stateName))).toEqual(stateBefore)
  expect(await readFile(complete.state.final.path)).toEqual(zipBefore)
  expect((await attempts(f.root)).some(({ record }) => record.mode === "revalidate-frozen" && record.status === "failed")).toBe(true)
  expect(mocks.run.mock.calls.filter(([, args]) => args.includes("-c"))).toHaveLength(0)
})

it("preserves unknown legacy output and an orphaned attempt instead of mixing it with a fresh extraction", async () => {
  const f = await fixture()
  installProcessDouble(f.app)
  for (const name of ["final", "verify-extracted"]) {
    await mkdir(join(f.root, name))
    await writeFile(join(f.root, name, "unknown-output"), "preserve this manual output")
  }
  const orphan = join(f.root, "attempts", "archive-11111111-2222-3333-4444-555555555555")
  await mkdir(orphan, { recursive: true })
  await writeFile(join(orphan, "incomplete-output"), "crash before journal commit")
  const before = await inventory(orphan)
  const result = await createFinalArchive(f.root)
  expect(result.state.final.path).toContain(`/attempts/${result.state.archiveAttempt}/final/`)
  for (const name of ["final", "verify-extracted"]) expect(await readFile(join(f.root, name, "unknown-output"), "utf8")).toBe("preserve this manual output")
  expect((await inventory(orphan)).sha256).toBe(before.sha256)
  const record = await readJSON(join(f.root, "attempts", result.state.archiveAttempt, "attempt.json"))
  expect(record.preservedUnrecognizedEntries).toContain("archive-11111111-2222-3333-4444-555555555555")
})

it("refuses ambiguous legacy submission output when its state is missing", async () => {
  const f = await fixture("signed")
  await mkdir(join(f.root, "notarization"))
  await writeFile(f.submissionPath, "possibly already approved")
  await expect(prepareSubmission(f.root, "fixture-profile")).rejects.toThrow("Unrecorded notarization output")
  expect(await readFile(f.submissionPath, "utf8")).toBe("possibly already approved")
  expect(mocks.run).not.toHaveBeenCalled()
})

it("never clears a stale lock or follows a symlinked attempt directory", async () => {
  const f = await fixture()
  const path = join(f.root, ".operation.lock")
  await writeFile(path, "fixture of a terminated owner\n")
  await expect(createFinalArchive(f.root)).rejects.toThrow("locked")
  expect(await readFile(path, "utf8")).toBe("fixture of a terminated owner\n")
  expect(mocks.run).not.toHaveBeenCalled()
  // The fixture represents an operator's separate review/removal, not automatic recovery.
  await rm(path)
  const outside = await realpath(await mkdtemp(join(tmpdir(), "unrelated-retry-output-")))
  roots.push(outside)
  await writeFile(join(outside, "sentinel"), "unrelated")
  await symlink(outside, join(f.root, "attempts"))
  await expect(createFinalArchive(f.root)).rejects.toThrow("not a symlink")
  expect(await readdir(outside)).toEqual(["sentinel"])
})

it("blocks changed state at commit rather than overwriting an external edit", async () => {
  const f = await fixture()
  installProcessDouble(f.app)
  const changed = { ...f.originalState!, profile: "external-profile-change" }
  mocks.verify.mockImplementationOnce(async () => { await writeJSON(join(f.root, stateName), changed); return f.manifest })
  await expect(createFinalArchive(f.root)).rejects.toThrow("state changed")
  expect(await readJSON(join(f.root, stateName))).toEqual(changed)
})

it("rejects an escaped or changed prepared-attempt reference before uploading", async () => {
  const f = await fixture("signed")
  installProcessDouble(f.app)
  const prepared = await prepareSubmission(f.root, "fixture-profile")
  await writeJSON(join(f.root, stateName), { ...prepared.state, preparationAttempt: "../unrelated" })
  mocks.run.mockClear()
  await expect(submitCandidate(f.root, prepared.state.submission.sha256)).rejects.toThrow("attempt reference")
  expect(mocks.run).not.toHaveBeenCalled()
})

it("uses a validated preparation attempt's exact ZIP and profile through submission/status", async () => {
  const f = await fixture("signed")
  installProcessDouble(f.app)
  const prepared = await prepareSubmission(f.root, "fixture-profile")
  const id = "11111111-2222-3333-4444-555555555555"
  mocks.run.mockClear()
  mocks.run.mockResolvedValueOnce({ code: 0, stdout: JSON.stringify({ id }) })
  const submitted = await submitCandidate(f.root, prepared.state.submission.sha256)
  expect(submitted.state.preparationAttempt).toBe(prepared.state.preparationAttempt)
  expect(submitted.state.submission).toEqual(prepared.state.submission)
  expect(mocks.run.mock.calls[0][1]).toEqual(["notarytool", "submit", prepared.state.submission.path, "--keychain-profile", "fixture-profile", "--no-wait", "--output-format", "json"])
  mocks.run.mockResolvedValueOnce({ code: 0, stdout: JSON.stringify({ id, name: "submission.zip", status: "Accepted" }) })
  const accepted = await refreshStatus(f.root, undefined)
  expect(accepted.state).toMatchObject({ status: "Accepted", submissionId: id, profile: "fixture-profile", preparationAttempt: prepared.state.preparationAttempt, submission: prepared.state.submission })
  expect(mocks.run).toHaveBeenCalledTimes(2)
})

it("records candidate mismatch before generating any local archive output", async () => {
  const f = await fixture()
  mocks.verify.mockResolvedValueOnce({ ...f.manifest, payload: { "app.asar": "changed" } })
  await expect(createFinalArchive(f.root)).rejects.toThrow("Candidate payload or signed code changed")
  expect(mocks.run).not.toHaveBeenCalled()
  const [failed] = await attempts(f.root)
  expect(failed.record).toMatchObject({ status: "failed", stage: "verify-candidate" })
  await expect(readdir(join(failed.directory, "final"))).rejects.toMatchObject({ code: "ENOENT" })
  expect(await readJSON(join(f.root, stateName))).toEqual(f.originalState)
})
