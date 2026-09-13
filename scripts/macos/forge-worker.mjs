// Invoked only by the explicit signed-package command in a bounded child process.
import { api, utils } from "@electron-forge/core"
import base from "../../forge.config.mjs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { readJSON, repository } from "./io.mjs"
import { assertProduction, requireMac, signedForgeConfig } from "./policy.mjs"

requireMac()
const root = process.argv[2]
const { signer } = await readJSON(join(root, "private-build-input.json"))
const config = signedForgeConfig(base, signer)
config.packagerConfig.afterCopy = [async ({ buildPath }) => {
  // Inspect the actual copied code before ASAR creation/signing, not just the source output.
  const mode = await readJSON(join(buildPath, "dist-electron/build-mode.json"))
  const main = await readFile(join(buildPath, "dist-electron/main.cjs"), "utf8")
  assertProduction(mode, main, ["dist-electron/main.cjs"])
}]
utils.registerForgeConfigForDirectory(repository, config)
try { await api.package({ dir: repository, platform: "darwin", arch: "arm64", outDir: join(root, "forge-output"), interactive: false }) }
finally { utils.unregisterForgeConfigForDirectory(repository) }
