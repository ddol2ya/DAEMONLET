import { parseArgs } from "node:util"
import { join } from "node:path"
import { mkdir } from "node:fs/promises"
import { publicSummary, requireMac } from "./macos/policy.mjs"
import { writeJSON } from "./macos/io.mjs"
import { buildSignedCandidate } from "./macos/package.mjs"
import { loadCandidate, prepareSubmission, submitCandidate, refreshStatus, stapleCandidate, createFinalArchive } from "./macos/notarize.mjs"
import { assertSameCode, verifyApp } from "./macos/verify.mjs"

const help = `Explicit macOS candidate workflow (no implicit signing or upload):

npm run macos:package:signed -- --output /absolute/new-candidate
  Requires MACOS_SIGNING_IDENTITY (exact name or SHA-1) and MACOS_EXPECTED_TEAM_ID.
  Commits must be clean. Builds production, signs a NEW candidate, verifies it.
  Does not submit to Apple or change an installed app.

npm run macos:verify -- --candidate /absolute/candidate [--app /absolute/copy.app] [--ticket]
  Verifies an existing app against its candidate signer; never builds or signs.

npm run macos:notarize -- prepare --candidate /absolute/candidate [--retry-reason "reason"]
  Freezes submission.zip; prints SHA-256 and size for explicit user approval.
  MACOS_NOTARY_PROFILE defaults to daemonlet-notary (default credential store).
npm run macos:notarize -- submit --candidate /absolute/candidate --approved-sha256 <approved-sha256>
  Uploads precisely that archive to Apple. Run only after explicit upload approval.
npm run macos:notarize -- status --candidate /absolute/candidate [--submission-id <recovered-original-id>]
  Queries the existing submission once. Does not wait indefinitely or resubmit.
npm run macos:notarize -- staple --candidate /absolute/candidate
  Checks the Accepted log/hash, staples, verifies signature and Gatekeeper.

npm run macos:archive -- --candidate /absolute/candidate [--retry-reason "reason"]
  Archives the existing stapled app; verifies a fresh extraction and its Hook host.
  Each invocation retains its own attempts/<id>/ output and private stage journal.
  Prepared/verified artifacts are revalidated without replacing their ZIP or state.
  A retry is explicit; it never clears a lock or resubmits an uncertain Apple upload.

Private candidate roots must be outside the checkout. Raw diagnostics and submission
IDs stay there. Upload, notarized archive, and actual installation are separate states.
These commands never replace an installed app or change Hook/config/Keychain settings.
`

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    help: { type: "boolean" }, output: { type: "string" }, candidate: { type: "string" },
    app: { type: "string" }, ticket: { type: "boolean" },
    "approved-sha256": { type: "string" }, "submission-id": { type: "string" }, "retry-reason": { type: "string" },
  } })
  if (values.help || positionals.length === 0) console.log(help)
  else {
    const [command, action] = positionals
    const allowed = { package: ["output"], verify: ["candidate", "app", "ticket"],
      notarize: ["candidate", ...(action === "submit" ? ["approved-sha256"] : action === "status" ? ["submission-id"] : action === "prepare" ? ["retry-reason"] : [])], archive: ["candidate", "retry-reason"] }[command]
    if (!allowed || Object.keys(values).some((key) => !allowed.includes(key)) || positionals.length !== (command === "notarize" ? 2 : 1)) throw new Error("Invalid command/options. Use --help.")
    requireMac()
    if (command === "package" ? !values.output : !values.candidate) throw new Error("Missing absolute --output or --candidate. Use --help.")
    let result
    if (command === "package") result = await buildSignedCandidate(values.output)
    else if (command === "verify") {
      const { root, manifest, app } = await loadCandidate(values.candidate)
      const evidence = join(root, "evidence-private", `verify-${Date.now()}`)
      await mkdir(evidence, { mode: 0o700 })
      const verified = await verifyApp(values.app ?? app, manifest.signer, { evidence, requireTicket: values.ticket })
      assertSameCode(manifest, verified)
      await writeJSON(join(evidence, "verification.json"), verified)
      result = { manifest, state: { status: values.ticket ? "signature-and-ticket-verified" : "signature-verified" } }
    } else if (command === "archive") result = await createFinalArchive(values.candidate, { retryReason: values["retry-reason"] })
    else {
      const operation = { prepare: () => prepareSubmission(values.candidate, undefined, { retryReason: values["retry-reason"] }), submit: () => submitCandidate(values.candidate, values["approved-sha256"]),
        status: () => refreshStatus(values.candidate, values["submission-id"]), staple: () => stapleCandidate(values.candidate) }[action]
      if (!operation) throw new Error("Unknown notarization action. Use --help.")
      result = await operation()
    }
    console.log(JSON.stringify(publicSummary(result.manifest, result.state), null, 2))
  }
} catch (error) {
  // Our process runner keeps raw command failures private. Avoid stack dumps.
  console.error(`macOS candidate: ${error.message}`)
  process.exitCode = 1
}
