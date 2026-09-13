import { mkdir, readFile, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { APP_NAME, requireMac, selectIdentity } from "./policy.mjs"
import { hashFile, privateDirectory, repository, run, writeJSON } from "./io.mjs"
import { verifyApp } from "./verify.mjs"

export async function currentSource() {
  const status = await run("git", ["status", "--porcelain=v1", "--untracked-files=all"])
  if (status.stdout.trim()) throw new Error("Commit the candidate source before packaging; dirty/untracked source is not a release candidate.")
  const sha = (await run("git", ["rev-parse", "HEAD"])).stdout.trim()
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Unable to identify source commit.")
  return sha
}

export async function buildSignedCandidate(output) {
  requireMac()
  if (process.arch !== "arm64") throw new Error("This candidate workflow currently targets macOS arm64.")
  if (!process.env.MACOS_SIGNING_IDENTITY?.trim() || !/^[A-Z0-9]{10}$/.test(process.env.MACOS_EXPECTED_TEAM_ID ?? "")) {
    throw new Error("MACOS_SIGNING_IDENTITY and MACOS_EXPECTED_TEAM_ID are required for explicit signing.")
  }
  const identities = await run("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"])
  const signer = selectIdentity(identities.stdout, process.env.MACOS_SIGNING_IDENTITY, process.env.MACOS_EXPECTED_TEAM_ID)
  const sourceCommit = await currentSource()
  const root = await privateDirectory(output, { fresh: true })
  const evidence = join(root, "evidence-private")
  await mkdir(evidence, { mode: 0o700 })
  await writeJSON(join(root, "private-build-input.json"), { sourceCommit, signer, architecture: process.arch })
  for (const name of ["jit", "empty"]) await run("/usr/bin/plutil", ["-lint", resolve(repository, `electron/build/entitlements/${name}.plist`)])
  await run("npm", ["run", "build:renderer"], { timeoutMs: 600_000, logPath: join(evidence, "build-renderer.json") })
  await run(process.execPath, ["electron/build/build-electron.mjs", "--production"], { timeoutMs: 180_000, logPath: join(evidence, "build-electron.json") })
  const expectedPayload = {}
  for (const name of ["hook-forwarder.mjs", "codex-adapter-worker.cjs"]) expectedPayload[`codex/${name}`] = await hashFile(join(repository, "dist-electron/codex", name))
  await run(process.execPath, ["scripts/macos/forge-worker.mjs", root], {
    timeoutMs: 900_000, maxBytes: 16 * 1024 * 1024, logPath: join(evidence, "forge-sign.json"),
    env: { ...process.env, DEBUG: "", LC_ALL: "C", LANG: "C" },
  })
  if (await currentSource() !== sourceCommit) throw new Error("Source changed while the candidate was building.")
  const packagedApp = join(root, "forge-output", `${APP_NAME}-darwin-arm64`, `${APP_NAME}.app`)
  const app = join(root, "signed", `${APP_NAME}.app`)
  await mkdir(join(root, "signed"), { mode: 0o700 })
  await run("/usr/bin/ditto", [packagedApp, app], { timeoutMs: 180_000 })
  const manifest = await verifyApp(app, signer, { evidence })
  for (const [name, hash] of Object.entries(expectedPayload)) if (manifest.payload[name] !== hash) throw new Error("Signing changed a bundled Hook/worker payload.")
  const pkg = JSON.parse(await readFile(join(repository, "package.json"), "utf8"))
  if (manifest.version !== pkg.version) throw new Error("Packaged version differs from source.")
  Object.assign(manifest, { sourceCommit, signer, architecture: process.arch, createdAt: new Date().toISOString(), privateKeySigningOperation: "verified" })
  await writeJSON(join(root, "private-manifest.json"), manifest)
  await rm(join(root, "forge-output"), { recursive: true })
  return { root, manifest }
}
