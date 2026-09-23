import { existsSync } from 'node:fs'
import {runtimeTarget, verifyRuntime} from '../main/character-chat/runtime-artifacts.mjs'
import { build } from "esbuild"
import { sourceIdentity, assertSameSource } from "../../scripts/release/validation.mjs"
import { requireElectronRuntime } from "../../scripts/release/electron-runtime.mjs"
import { copyFile, mkdir, readFile, rm, writeFile, cp } from "node:fs/promises"
import { resolve } from "node:path"
import { writeLicenseBundle } from "../../scripts/release/licenses.mjs"

const root = resolve(import.meta.dirname, "../..")
await requireElectronRuntime(root)
const outdir = resolve(root, "dist-electron")
const production = process.argv.includes("--production")
const source = await sourceIdentity(root)
if (production) assertSameSource(source, JSON.parse(await readFile(resolve(root, "dist/build-source.json"), "utf8")))
const setupSmoke = process.argv.includes("--setup-smoke")
await rm(outdir, { recursive: true, force: true })
await mkdir(resolve(outdir, "codex"), { recursive: true })
const chatTarget = runtimeTarget(process.env.PET_BUILD_PLATFORM || process.platform, process.env.PET_BUILD_ARCH || process.arch)
const chatRuntime = resolve(root, '.generated/character-chat-runtime-package', chatTarget)
if (existsSync(chatRuntime)) {
 await verifyRuntime(chatRuntime, chatTarget)
 await cp(chatRuntime,resolve(outdir,'local-llm'),{recursive:true})
}
// Source-only CI may compile without native artifacts. Forge requires the pinned runtime before packaging.
await mkdir(resolve(outdir, "licenses"), { recursive: true })

const common = {
  absWorkingDir: root,
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  external: ["electron"],
  sourcemap: production ? false : "linked",
  minify: production,
  metafile: true,
  logLevel: "info",
  define: { __SETUP_SMOKE__: JSON.stringify(setupSmoke), __APP_QA__: JSON.stringify(!production || setupSmoke) },
}

const bundles = await Promise.all([
  build({ ...common, entryPoints: [resolve(root, "electron/preload/character-chat-preload.ts")], outfile: resolve(outdir, "character-chat-preload.cjs") }),
  build({ ...common, entryPoints: [resolve(root, "electron/utility/character-pack-worker.ts")], outfile: resolve(outdir, "character-pack-worker.cjs") }),
  build({ ...common, entryPoints: [resolve(root, "electron/main/main.ts")], outfile: resolve(outdir, "main.cjs") }),
  build({ ...common, entryPoints: [resolve(root, "electron/preload/pet-preload.ts")], outfile: resolve(outdir, "pet-preload.cjs") }),
  build({ ...common, entryPoints: [resolve(root, "electron/preload/lab-preload.ts")], outfile: resolve(outdir, "lab-preload.cjs") }),
  build({ ...common, entryPoints: [resolve(root, "electron/preload/settings-preload.ts")], outfile: resolve(outdir, "settings-preload.cjs") }),
  build({ ...common, entryPoints: [resolve(root, "electron/preload/activity-preload.ts")], outfile: resolve(outdir, "activity-preload.cjs") }),
  build({ ...common, entryPoints: [resolve(root, "electron/preload/speech-preload.ts")], outfile: resolve(outdir, "speech-preload.cjs") }),
  build({ ...common, entryPoints: [resolve(root, "electron/utility/codex-adapter-worker.ts")], outfile: resolve(outdir, "codex/codex-adapter-worker.cjs") }),
])

const productionInputs = [...new Set(bundles.flatMap(result => Object.keys(result.metafile.inputs)))].sort()
if (production && !setupSmoke && productionInputs.some(file => /(?:Smoke|fixture|tests\/|scripts\/side-chat|runtime-patches)/i.test(file))) throw Error("QA code reached the production graph")
await writeFile(resolve(outdir, "bundle-inputs.json"), JSON.stringify({ production: production && !setupSmoke, inputs: productionInputs }) + "\n")
await writeLicenseBundle(resolve(outdir, "licenses"), bundles.flatMap(result => Object.keys(result.metafile.inputs)))

await copyFile(resolve(root, "adapter/codex/hooks/hook-forwarder.mjs"), resolve(outdir, "codex/hook-forwarder.mjs"))
await copyFile(resolve(root, "node_modules/@electron/fuses/LICENSE"), resolve(outdir, "licenses/electron-fuses.txt"))
await copyFile(resolve(root, "node_modules/smol-toml/LICENSE"), resolve(outdir, "licenses/smol-toml.txt"))
await copyFile(resolve(root, "node_modules/yauzl/LICENSE"), resolve(outdir, "licenses/yauzl.txt"))
await copyFile(resolve(root, "node_modules/stream-json/LICENSE"), resolve(outdir, "licenses/stream-json.txt"))
await copyFile(resolve(root, "node_modules/stream-chain/LICENSE"), resolve(outdir, "licenses/stream-chain.txt"))
await copyFile(resolve(root, "THIRD_PARTY_NOTICES.md"), resolve(outdir, "licenses/THIRD_PARTY_NOTICES.md"))
await writeFile(resolve(outdir, "versions.json"), `${JSON.stringify({ electron: "43.4.0", chromium: "150.0.7871.224", node: "24.18.1", forge: "8.0.0-alpha.10", esbuild: "0.28.2" }, null, 2)}\n`)
// setup:smoke uses optimized output too, but its test-only app is never a production candidate.
await writeFile(resolve(outdir, "build-mode.json"), `${JSON.stringify({ schemaVersion: 1, production: production && !setupSmoke, setupSmoke })}\n`)

await writeFile(resolve(outdir, "app-update.yml"), JSON.stringify({ provider: "github", owner: "ddol2ya", repo: "DAEMONLET", private: false, updaterCacheDirName: "daemonlet-for-codex-updater" }) + "\n")

await import("./build-dictation.mjs")
await import("./build-hook-host.mjs")
await import("../../scripts/release/stage-notices.mjs")

assertSameSource(source, await sourceIdentity(root))
await writeFile(resolve(outdir, "build-source.json"), JSON.stringify(source) + "\n")
