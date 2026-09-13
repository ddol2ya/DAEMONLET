import { lstat, mkdir, readdir } from "node:fs/promises"
import { join } from "node:path"
import { APP_NAME, NOTARY_PROFILE, assertCanSubmit, assertUploadApproval, notaryStatus } from "./policy.mjs"
import { hashFile, hashObject, privateDirectory, readJSON, run, withLock, writeJSON } from "./io.mjs"
import { assertOnlyTicketAdded, assertSameBundle, candidateApp, verifyApp } from "./verify.mjs"
import { linkedAttempt, localAttempt, optionalJSON, ownedDirectory } from "./attempts.mjs"

const stateName = "private-submission-state.json"
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const stamp = () => new Date().toISOString()

export async function loadCandidate(root) {
  root = await privateDirectory(root)
  const manifest = await readJSON(join(root, "private-manifest.json"))
  if (manifest.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(manifest.sourceCommit ?? "")) throw new Error("Invalid candidate manifest.")
  const app = await candidateApp(root)
  if (app !== manifest.app) throw new Error("Candidate moved; verify a copy using --app instead of repointing notarization state.")
  return { root, manifest, app }
}

async function archiveInfo(path) {
  const info = await lstat(path)
  if (!info.isFile() || info.size === 0) throw new Error("Expected a nonempty archive file.")
  return { path, sha256: await hashFile(path), bytes: info.size }
}

async function validateSubmission(root, state, manifest) {
  if (state.schemaVersion !== 1 || state.sourceCommit !== manifest.sourceCommit) throw new Error("Submission state belongs to a different candidate.")
  let path = join(root, "notarization/submission.zip")
  if (state.preparationAttempt !== undefined) {
    const { directory, record } = await linkedAttempt(root, manifest, state.preparationAttempt, "prepare")
    path = join(directory, "submission.zip")
    if (record.inputs.profile !== state.profile || hashObject(record.result?.submission) !== hashObject(state.submission)) {
      throw new Error("Frozen submission differs from its validated preparation attempt.")
    }
  } else await ownedDirectory(join(root, "notarization")) // Existing S1 candidates retain their original paths.
  if (state.submission.path !== path) throw new Error("Submission path differs from the frozen candidate.")
  const actual = await archiveInfo(path)
  if (hashObject(actual) !== hashObject(state.submission)) throw new Error("Frozen submission archive changed.")
  return actual
}

async function assertStateUnchanged(root, expectedHash) {
  const current = await optionalJSON(join(root, stateName))
  const actualHash = current === null ? null : await hashFile(join(root, stateName))
  if (actualHash !== expectedHash) throw new Error("Candidate state changed during local verification; nothing was committed.")
}

async function verifyForAttempt(attempt, stage, app, signer, requireTicket = false) {
  await attempt.stage(stage)
  const evidence = await ownedDirectory(join(attempt.directory, "evidence"), { create: true })
  const directory = join(evidence, stage)
  await mkdir(directory, { mode: 0o700 })
  return verifyApp(app, signer, { requireTicket, evidence: directory })
}

/** @param {string} candidateRoot @param {string} [profile] @param {{retryReason?: string}} [options] */
export async function prepareSubmission(candidateRoot, profile = process.env.MACOS_NOTARY_PROFILE ?? NOTARY_PROFILE, { retryReason } = {}) {
  const { root, manifest, app } = await loadCandidate(candidateRoot)
  if (!profile?.trim() || profile.startsWith("-") || /[\r\n\0]/.test(profile)) throw new Error("Invalid Keychain profile name.")
  return withLock(root, async () => {
    const existing = await optionalJSON(join(root, stateName))
    const stateHash = existing === null ? null : await hashFile(join(root, stateName))
    if (existing) {
      assertCanSubmit(existing) // In particular, never reset a submission-uncertain state.
      if (existing.profile !== profile) throw new Error("Prepared profile is frozen; a local retry cannot change it.")
    } else {
      // A legacy partial ZIP without state could already have been approved. Do
      // not guess its status or replace it with a newly prepared submission.
      const directory = await ownedDirectory(join(root, "notarization"), { create: true })
      if ((await readdir(directory)).length) throw new Error("Unrecorded notarization output exists. Preserve it and restore its matching state before preparing this candidate.")
    }
    return localAttempt(root, manifest, "prepare", { retryReason, mode: existing ? "revalidate-frozen" : "create", inputs: { profile, stateHash } }, async (attempt) => {
      const verified = await verifyForAttempt(attempt, "verify-candidate", app, manifest.signer)
      assertSameBundle(manifest, verified)
      // Source-controlled production resources only; no local credentials or evidence.
      if (verified.inventory.entries.some(({ path }) => /(?:^|\/)(?:\.env[^/]*|hooks\.json|config\.toml|adapter-token|.*\.(?:p12|p8|pem|certSigningRequest))$/i.test(path))) {
        throw new Error("Unexpected private material in the candidate bundle.")
      }
      if (existing) {
        await attempt.stage("verify-frozen-submission")
        await validateSubmission(root, existing, manifest)
        await attempt.stage("verify-state")
        await assertStateUnchanged(root, stateHash)
        await attempt.stage("revalidation-complete")
        await attempt.validated({ submission: existing.submission, canonicalStateUnchanged: true })
        return { manifest, state: existing }
      }
      const zip = join(attempt.directory, "submission.zip")
      await attempt.stage("compress-submission")
      await run("/usr/bin/ditto", ["-c", "-k", "--keepParent", app, zip], { timeoutMs: 300_000, logPath: join(attempt.directory, "compression.json") })
      assertSameBundle(manifest, await verifyForAttempt(attempt, "verify-candidate-after", app, manifest.signer))
      const state = { schemaVersion: 1, sourceCommit: manifest.sourceCommit, profile, status: "prepared", createdAt: stamp(), preparationAttempt: attempt.id,
        submission: await archiveInfo(zip), destination: "Apple notarization service", includes: ["Electron application and frameworks", "production ASAR", "bundled Hook and worker", "built-in character PNG/PSD resources"] }
      await attempt.stage("verify-state")
      await assertStateUnchanged(root, stateHash)
      await attempt.stage("commit-state")
      await attempt.validated({ submission: state.submission, proposedStateSHA256: hashObject(state) })
      await writeJSON(join(root, stateName), state) // Last write: the atomic pointer is the commit, not the journal alone.
      return { manifest, state }
    })
  })
}

export async function submitCandidate(candidateRoot, approvedHash) {
  const { root, manifest, app } = await loadCandidate(candidateRoot)
  return withLock(root, async () => {
    const state = await readJSON(join(root, stateName))
    assertCanSubmit(state)
    assertSameBundle(manifest, await verifyApp(app, manifest.signer))
    const archive = await validateSubmission(root, state, manifest)
    assertUploadApproval(archive.sha256, approvedHash)
    await ownedDirectory(join(root, "notarization"), { create: true })
    // Persist before the network request. A crash or failed response is not permission
    // to submit again: recover the original ID from the private log/service history.
    state.status = "submission-uncertain"
    state.submissionAttemptedAt = stamp()
    state.approvedSha256 = approvedHash
    await writeJSON(join(root, stateName), state)
    const result = await run("/usr/bin/xcrun", ["notarytool", "submit", archive.path, "--keychain-profile", state.profile, "--no-wait", "--output-format", "json"], {
      timeoutMs: 900_000, logPath: join(root, "notarization/submit-result.json"),
    })
    const response = JSON.parse(result.stdout)
    if (!uuid.test(response.id ?? "")) throw new Error("Upload response lacked a submission ID; inspect the private log before recovery.")
    state.submissionId = response.id
    state.status = "Submitted"
    await writeJSON(join(root, stateName), state)
    return { manifest, state }
  })
}

export async function refreshStatus(candidateRoot, recoveredId) {
  const { root, manifest } = await loadCandidate(candidateRoot)
  return withLock(root, async () => {
    const state = await readJSON(join(root, stateName))
    await validateSubmission(root, state, manifest)
    if (recoveredId) {
      if (state.status !== "submission-uncertain" || state.submissionId || !uuid.test(recoveredId)) throw new Error("Only an uncertain submission can recover its original ID.")
    }
    const id = recoveredId ?? state.submissionId
    if (!uuid.test(id ?? "")) throw new Error("No submitted candidate to query.")
    const result = await run("/usr/bin/xcrun", ["notarytool", "info", id, "--keychain-profile", state.profile, "--output-format", "json"], { logPath: join(root, "notarization/info-result.json") })
    const response = JSON.parse(result.stdout)
    if (response.id !== id || response.name !== "submission.zip") throw new Error("Notary response does not identify the expected submission.")
    const status = notaryStatus(response.status)
    if (recoveredId) {
      // Apple log's sha256 binds an adopted ID to the archive; an ID alone is insufficient.
      if (status === "In Progress") throw new Error("Wait for processing to finish before recovering an ID via its SHA-256 log.")
      const log = await fetchLog(root, state.profile, id)
      if (log.sha256?.toLowerCase() !== state.submission.sha256) throw new Error("Recovered submission log does not match the approved archive.")
    }
    state.submissionId = id
    if (!["notarized-candidate", "verified-archive"].includes(state.status)) state.status = status
    state.appleStatus = status
    state.lastCheckedAt = stamp()
    await writeJSON(join(root, stateName), state)
    return { manifest, state }
  })
}

async function fetchLog(root, profile, id) {
  const path = join(root, "notarization/apple-log.json")
  // With no output filename, notarytool emits the log on stdout. Preserve it privately.
  const result = await run("/usr/bin/xcrun", ["notarytool", "log", id, "--keychain-profile", profile], { logPath: join(root, "notarization/log-result.json") })
  const log = JSON.parse(result.stdout)
  await writeJSON(path, log)
  return log
}

export async function stapleCandidate(candidateRoot) {
  const { root, manifest, app } = await loadCandidate(candidateRoot)
  return withLock(root, async () => {
    const state = await readJSON(join(root, stateName))
    if (state.status !== "Accepted" || !uuid.test(state.submissionId ?? "")) throw new Error("The same candidate must have a verified Accepted response before stapling.")
    await validateSubmission(root, state, manifest)
    const log = await fetchLog(root, state.profile, state.submissionId)
    if (log.jobId !== state.submissionId || log.status !== "Accepted" || log.sha256?.toLowerCase() !== state.submission.sha256) throw new Error("Apple's log does not match the accepted archive.")
    const issues = log.issues ?? []
    if (!Array.isArray(issues) || issues.some((issue) => issue.severity === "error")) throw new Error("Accepted log contains errors or an invalid issue list.")
    const before = await verifyApp(app, manifest.signer)
    // Allow retry after a completed staple whose subsequent verification was interrupted.
    assertOnlyTicketAdded(manifest, before)
    await run("/usr/bin/xcrun", ["stapler", "staple", app], { logPath: join(root, "notarization/staple-result.json") })
    const verified = await verifyApp(app, manifest.signer, { requireTicket: true, evidence: join(root, "evidence-private") })
    assertOnlyTicketAdded(manifest, verified)
    await writeJSON(join(root, "private-stapled-manifest.json"), verified)
    state.status = "notarized-candidate"
    state.stapledAt = stamp()
    state.logReview = { status: log.status, warnings: issues.filter((issue) => issue.severity === "warning").length, errors: 0 }
    await writeJSON(join(root, stateName), state)
    return { manifest, state }
  })
}

function finalName(manifest) {
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(manifest.version ?? "")) throw new Error("Invalid candidate version for archive name.")
  return `${APP_NAME}-${manifest.version}-${manifest.sourceCommit.slice(0,12)}-darwin-arm64.zip`
}

async function validateFinal(root, manifest, state) {
  let path = join(root, "final", finalName(manifest))
  if (state.archiveAttempt !== undefined) {
    const { directory, record } = await linkedAttempt(root, manifest, state.archiveAttempt, "archive")
    await ownedDirectory(join(directory, "final"))
    path = join(directory, "final", finalName(manifest))
    if (hashObject(record.result?.final) !== hashObject(state.final)) throw new Error("Final archive differs from its validated attempt.")
  } else await ownedDirectory(join(root, "final"))
  if (state.final?.path !== path || hashObject(await archiveInfo(path)) !== hashObject(state.final)) throw new Error("Verified final archive changed.")
  return state.final
}

/** @param {string} candidateRoot @param {{retryReason?: string}} [options] */
export async function createFinalArchive(candidateRoot, { retryReason } = {}) {
  const { root, manifest, app } = await loadCandidate(candidateRoot)
  return withLock(root, async () => {
    const state = await readJSON(join(root, stateName))
    if (!["notarized-candidate", "verified-archive"].includes(state.status)) throw new Error("Final archive requires a verified stapled candidate.")
    const stateHash = await hashFile(join(root, stateName))
    const stapled = await readJSON(join(root, "private-stapled-manifest.json"))
    const revalidate = state.status === "verified-archive"
    return localAttempt(root, manifest, "archive", { retryReason, mode: revalidate ? "revalidate-frozen" : "create", inputs: { stateHash, submission: state.submission } }, async (attempt) => {
      assertSameBundle(stapled, await verifyForAttempt(attempt, "verify-candidate", app, manifest.signer, true))
      await attempt.stage("verify-submission")
      await validateSubmission(root, state, manifest)
      const finalDirectory = join(attempt.directory, "final")
      const extraction = join(attempt.directory, "verify-extracted")
      let final
      if (revalidate) {
        await attempt.stage("verify-frozen-final")
        final = await validateFinal(root, manifest, state)
      } else {
        await mkdir(finalDirectory, { mode: 0o700 })
        await attempt.stage("compress-final")
        const path = join(finalDirectory, finalName(manifest))
        await run("/usr/bin/ditto", ["-c", "-k", "--keepParent", app, path], { timeoutMs: 300_000, logPath: join(attempt.directory, "compression.json") })
        final = await archiveInfo(path)
      }
      await mkdir(extraction, { mode: 0o700 })
      await attempt.stage("extract-final")
      await run("/usr/bin/ditto", ["-x", "-k", final.path, extraction], { timeoutMs: 180_000, logPath: join(attempt.directory, "extraction.json") })
      if (hashObject(await readdir(extraction)) !== hashObject([`${APP_NAME}.app`])) throw new Error("Final ZIP must contain only the app.")
      const extractedApp = join(extraction, `${APP_NAME}.app`)
      const verified = await verifyForAttempt(attempt, "verify-extracted", extractedApp, manifest.signer, true)
      assertSameBundle(stapled, verified)
      await attempt.stage("verify-hook")
      await run(process.execPath, ["--experimental-strip-types", "scripts/hook-host-proof.ts", extractedApp, "--output", join(attempt.directory, "extracted-host.json")], {
        timeoutMs: 180_000, logPath: join(attempt.directory, "extracted-host-process.json"),
      })
      assertSameBundle(stapled, await verifyForAttempt(attempt, "verify-extracted-after", extractedApp, manifest.signer, true))
      assertSameBundle(stapled, await verifyForAttempt(attempt, "verify-candidate-after", app, manifest.signer, true))
      await attempt.stage("verify-final-artifacts")
      if (hashObject(await archiveInfo(final.path)) !== hashObject(final)) throw new Error("Final archive changed during verification.")
      await validateSubmission(root, state, manifest)
      await attempt.stage("verify-state")
      await assertStateUnchanged(root, stateHash)
      await attempt.stage("record-extraction")
      const extractedManifest = join(attempt.directory, "extracted-manifest.json")
      await writeJSON(extractedManifest, verified)
      if (revalidate) {
        await attempt.stage("revalidation-complete")
        await attempt.validated({ final, extraction, extractedManifest, canonicalStateUnchanged: true })
        return { manifest, state }
      }
      const next = { ...state, final, status: "verified-archive", archiveVerifiedAt: stamp(), archiveAttempt: attempt.id, finalExtraction: extraction, extractedManifest }
      await attempt.stage("commit-state")
      await attempt.validated({ final, extraction, extractedManifest, proposedStateSHA256: hashObject(next) })
      await writeJSON(join(root, stateName), next)
      return { manifest, state: next }
    })
  })
}
