import { extractFile, listPackage } from "@electron/asar"
import { FuseState, FuseV1Options, getCurrentFuseWire } from "@electron/fuses"
import { lstat, realpath } from "node:fs/promises"
import { isAbsolute, join, relative } from "node:path"
import { APP_NAME, BUNDLE_ID, assertEntitlements, isDictationCode, assertProduction, parseSignature, requireMac } from "./policy.mjs"
import { hashFile, hashObject, inventory, run, within, writeJSON } from "./io.mjs"
import { checkCandidate } from "../release/check.mjs"
import { checkExternalNotices } from "../release/check-notices.mjs"

export async function plist(path) {
  return JSON.parse((await run("/usr/bin/plutil", ["-convert", "json", "-o", "-", path])).stdout)
}

export function inspectAsar(path, appName = APP_NAME) {
  const entries = listPackage(path)
  const mode = JSON.parse(extractFile(path, "dist-electron/build-mode.json").toString())
  assertProduction(mode, extractFile(path, "dist-electron/main.cjs").toString(), entries)
  const pkg = JSON.parse(extractFile(path, "package.json").toString())
  if (pkg.productName !== appName || pkg.main !== "dist-electron/main.cjs") throw new Error("Unexpected packaged application contract.")
  return { version: pkg.version, entryCount: entries.length, mode }
}

export async function verifyApp(requestedApp, expected, { evidence, requireTicket = false } = {}) {
  const appName = APP_NAME
  const bundleId = BUNDLE_ID
  requireMac()
  if (!isAbsolute(requestedApp) || !(await lstat(requestedApp)).isDirectory()) throw new Error("An existing absolute .app path is required.")
  const app = await realpath(requestedApp)
  if (!app.endsWith(`/${appName}.app`)) throw new Error("Unexpected candidate app name.")
  if (!/^[A-F0-9]{40}$/.test(expected?.fingerprint ?? "") || !/^[A-Z0-9]{10}$/.test(expected?.team ?? "")) throw new Error("Expected signer fingerprint and team are required.")
  const before = await inventory(app)
  const info = await plist(join(app, "Contents/Info.plist"))
  if (info.CFBundleIdentifier !== bundleId || info.CFBundleExecutable !== appName || info.LSUIElement !== true) throw new Error("Bundle metadata does not match the production app.")
  const asar = join(app, "Contents/Resources/app.asar")
  const production = inspectAsar(asar, appName)
  await checkCandidate(asar)
  await checkExternalNotices(join(app, "Contents/Resources/licenses"))
  if (production.version !== info.CFBundleShortVersionString) throw new Error("Bundle and package versions differ.")
  // Pin the leaf certificate directly in a codesign requirement; no certificate/private-key export.
  const requirement = `=anchor apple generic and certificate leaf = H"${expected.fingerprint}" and certificate leaf[subject.OU] = "${expected.team}"`
  await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", "-R", requirement, app])
  const targets = [app, ...before.entries.filter((entry) => entry.machO || entry.type === "directory" && /\.(app|framework)$/.test(entry.path)).map((entry) => join(app, entry.path))]
  const signedCode = []
  for (const [index, target] of targets.entries()) {
    await run("/usr/bin/codesign", ["--verify", "--strict", "-R", requirement, target])
    const display = await run("/usr/bin/codesign", ["--display", "--verbose=4", target])
    const signature = parseSignature(display.stderr + display.stdout, expected, { root: target === app, bundleId })
    const entitlementsResult = await run("/usr/bin/codesign", ["--display", "--entitlements", ":-", target])
    let entitlements = {}
    if (entitlementsResult.stdout.trim()) entitlements = JSON.parse((await run("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", "-"], { input: entitlementsResult.stdout })).stdout)
    const keys = assertEntitlements(entitlements, isDictationCode(target))
    signedCode.push({ path: relative(app, target) || ".", ...signature, entitlements: keys })
    if (evidence) await writeJSON(join(evidence, `code-${index}.json`), { display, entitlementsResult })
  }
  const fuses = await getCurrentFuseWire(app)
  if (fuses[FuseV1Options.RunAsNode] !== FuseState.ENABLE) throw new Error("Packaged Hook requires RunAsNode enabled.")
  const payload = {}
  for (const name of ["app.asar", "codex/hook-forwarder.mjs", "codex/codex-adapter-worker.cjs"]) payload[name] = await hashFile(join(app, "Contents/Resources", name))
  if (requireTicket) {
    await run("/usr/bin/xcrun", ["stapler", "validate", app], { logPath: evidence && join(evidence, "stapler-validate.json") })
    await run("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=4", app], { logPath: evidence && join(evidence, "gatekeeper.json") })
  }
  const after = await inventory(app)
  if (after.sha256 !== before.sha256) throw new Error("Candidate changed during read-only verification.")
  return { schemaVersion: 1, app, version: production.version, bundleId, signerMatched: true,
    payload, signedCode, fuses, runAsNode: "enabled", inventory: before, ticket: requireTicket ? "validated" : "not-assessed" }
}

export function assertSameCode(before, after) {
  if (hashObject(before.payload) !== hashObject(after.payload) || hashObject(before.signedCode) !== hashObject(after.signedCode)) {
    throw new Error("Candidate payload or signed code changed.")
  }
}

export function assertSameBundle(before, after) {
  assertSameCode(before, after)
  if (before.inventory.sha256 !== after.inventory.sha256) throw new Error("Frozen candidate bundle changed.")
}

export function assertOnlyTicketAdded(before, after) {
  assertSameCode(before, after)
  const current = new Map(after.inventory.entries.map((entry) => [entry.path, entry]))
  for (const entry of before.inventory.entries) {
    if (hashObject(entry) !== hashObject(current.get(entry.path))) throw new Error("Staple modified a pre-existing bundle resource.")
    current.delete(entry.path)
  }
  // Apple's stapler stores the detached ticket here, outside the sealed resources.
  if ([...current.keys()].some((path) => path !== "Contents/CodeResources")) throw new Error("Unexpected bundle addition during stapling.")
}

export async function candidateApp(root) {
  const app = await realpath(join(root, "signed", `${APP_NAME}.app`))
  if (!within(root, app)) throw new Error("Candidate app escapes its private root.")
  return app
}
