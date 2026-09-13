import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ run: vi.fn(), verify: vi.fn() }))
vi.mock("../scripts/macos/io.mjs", async (original) => ({ ...await original<typeof import("../scripts/macos/io.mjs")>(), run: mocks.run }))
vi.mock("../scripts/macos/verify.mjs", async (original) => ({ ...await original<typeof import("../scripts/macos/verify.mjs")>(), verifyApp: mocks.verify }))

import { hashFile, readJSON, writeJSON } from "../scripts/macos/io.mjs"
import { createFinalArchive, refreshStatus, stapleCandidate, submitCandidate } from "../scripts/macos/notarize.mjs"

const roots: string[] = []
const submissionId = "11111111-2222-3333-4444-555555555555"
const stateFile = "private-submission-state.json"
beforeEach(() => { mocks.run.mockReset(); mocks.verify.mockReset() })
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

async function fixture(status = "prepared") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "notarization-state-test-")))
  roots.push(root)
  const app = join(root, "signed/Daemonlet for Codex.app")
  await mkdir(app, { recursive: true })
  await mkdir(join(root, "notarization"))
  await mkdir(join(root, "evidence-private"))
  const zip = join(root, "notarization/submission.zip")
  await writeFile(zip, "frozen-submission")
  const manifest = { schemaVersion: 1, sourceCommit: "a".repeat(40), app, version: "0.2.0", signer: { team: "ABCDEFGHIJ", fingerprint: "A".repeat(40) }, payload: { "app.asar": "b".repeat(64) }, signedCode: [], inventory: { entries: [], sha256: "c".repeat(64) } }
  const state = { schemaVersion: 1, sourceCommit: manifest.sourceCommit, profile: "test-notary", status, submissionId: status === "prepared" ? undefined : submissionId, submission: { path: zip, sha256: await hashFile(zip), bytes: 17 } }
  await writeJSON(join(root, "private-manifest.json"), manifest)
  await writeJSON(join(root, stateFile), state)
  mocks.verify.mockResolvedValue(manifest)
  return { root, state, manifest, zip }
}

it("rejects changed ZIP bytes and absent approval before any upload", async () => {
  const { root, state, zip } = await fixture()
  await expect(submitCandidate(root, undefined)).rejects.toThrow("approval")
  expect(mocks.run).not.toHaveBeenCalled()
  await writeFile(zip, "modified-submission")
  await expect(submitCandidate(root, state.submission.sha256)).rejects.toThrow("archive changed")
  expect(mocks.run).not.toHaveBeenCalled()
  expect((await readJSON(join(root, stateFile))).status).toBe("prepared")
})

it("persists an uncertain attempt before upload and refuses automatic retries", async () => {
  const { root, state } = await fixture()
  mocks.run.mockImplementation(async () => {
    expect((await readJSON(join(root, stateFile))).status).toBe("submission-uncertain")
    throw new Error("network failure")
  })
  await expect(submitCandidate(root, state.submission.sha256)).rejects.toThrow("network failure")
  await expect(submitCandidate(root, state.submission.sha256)).rejects.toThrow("already attempted")
  expect(mocks.run).toHaveBeenCalledTimes(1)
})

it("uses the frozen profile and same submission ID when resuming", async () => {
  const { root, state } = await fixture()
  mocks.run.mockResolvedValueOnce({ code: 0, stdout: JSON.stringify({ id: submissionId }) })
  expect((await submitCandidate(root, state.submission.sha256)).state.status).toBe("Submitted")
  expect(mocks.run.mock.calls[0][1]).toEqual(["notarytool", "submit", state.submission.path, "--keychain-profile", "test-notary", "--no-wait", "--output-format", "json"])
  mocks.run.mockResolvedValueOnce({ code: 0, stdout: JSON.stringify({ id: submissionId, name: "submission.zip", status: "In Progress" }) })
  expect((await refreshStatus(root, undefined)).state.status).toBe("In Progress")
  expect(mocks.run.mock.calls[1][1]).toContain(submissionId)
  expect(mocks.run.mock.calls[1][1]).not.toContain("submit")
})

it.each(["Invalid", "Rejected"])("keeps Apple's %s state distinct from success", async (status) => {
  const { root } = await fixture("Submitted")
  mocks.run.mockResolvedValue({ code: 0, stdout: JSON.stringify({ id: submissionId, name: "submission.zip", status }) })
  expect((await refreshStatus(root, undefined)).state.status).toBe(status)
  await expect(stapleCandidate(root)).rejects.toThrow("Accepted")
})

it("does not convert a malformed or failed status query into Accepted", async () => {
  const { root } = await fixture("In Progress")
  mocks.run.mockRejectedValueOnce(new Error("network failure"))
  await expect(refreshStatus(root, undefined)).rejects.toThrow("network failure")
  expect((await readJSON(join(root, stateFile))).status).toBe("In Progress")
  mocks.run.mockResolvedValueOnce({ code: 0, stdout: JSON.stringify({ id: submissionId, name: "submission.zip", status: "Success" }) })
  await expect(refreshStatus(root, undefined)).rejects.toThrow("not success")
  expect((await readJSON(join(root, stateFile))).status).toBe("In Progress")
})

it("requires the accepted log's hash and successful staple before finalizing", async () => {
  const { root, state } = await fixture("Accepted")
  mocks.run.mockResolvedValueOnce({ code: 0, stdout: JSON.stringify({ jobId: submissionId, status: "Accepted", sha256: "f".repeat(64), issues: null }) })
  await expect(stapleCandidate(root)).rejects.toThrow("does not match")
  mocks.run.mockResolvedValueOnce({ code: 0, stdout: JSON.stringify({ jobId: submissionId, status: "Accepted", sha256: state.submission.sha256, issues: null }) })
  mocks.run.mockRejectedValueOnce(new Error("staple failed"))
  await expect(stapleCandidate(root)).rejects.toThrow("staple failed")
  expect((await readJSON(join(root, stateFile))).status).toBe("Accepted")
  await expect(createFinalArchive(root)).rejects.toThrow("verified stapled")
})

it("cannot declare a final archive verified when fresh extraction verification fails", async () => {
  const { root, manifest } = await fixture("notarized-candidate")
  await writeJSON(join(root, "private-stapled-manifest.json"), manifest)
  mocks.run.mockImplementation(async (_file: string, args: string[]) => {
    if (args.includes("-c")) await writeFile(args.at(-1)!, "archive-fixture")
    if (args.includes("-x")) await mkdir(join(args.at(-1)!, "Daemonlet for Codex.app"))
    return { code: 0, stdout: "" }
  })
  mocks.verify.mockResolvedValueOnce(manifest).mockRejectedValueOnce(new Error("extracted signature failed"))
  await expect(createFinalArchive(root)).rejects.toThrow("extracted signature failed")
  const state = await readJSON(join(root, stateFile))
  expect(state.status).toBe("notarized-candidate")
  expect(state.final).toBeUndefined()
})
