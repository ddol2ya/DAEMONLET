import { build } from "esbuild"
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { writeLicenseBundle } from "../../scripts/release/licenses.mjs"

const root = resolve(import.meta.dirname, "../..")
const outdir = resolve(root, "dist-electron")
const production = process.argv.includes("--production")
const setupSmoke = process.argv.includes("--setup-smoke")
await rm(outdir, { recursive: true, force: true })
await mkdir(resolve(outdir, "codex"), { recursive: true })
await mkdir(resolve(outdir, "licenses"), { recursive: true })

const common = {
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  external: ["electron"],
  sourcemap: production ? false : "linked",
  minify: production,
  metafile: true,
  logLevel: "info",
  define: { __SETUP_SMOKE__: JSON.stringify(setupSmoke) },
}

const bundles = await Promise.all([
  build({ ...common, entryPoints: [resolve(root, "electron/utility/character-pack-worker.ts")], outfile: resolve(outdir, "character-pack-worker.cjs") }),
  build({ ...common, entryPoints: [resolve(root, "electron/main/main.ts")], outfile: resolve(outdir, "main.cjs") }),
  build({ ...common, entryPoints: [resolve(root, "electron/preload/pet-preload.ts")], outfile: resolve(outdir, "pet-preload.cjs") }),
  build({ ...common, entryPoints: [resolve(root, "electron/preload/lab-preload.ts")], outfile: resolve(outdir, "lab-preload.cjs") }),
  build({ ...common, entryPoints: [resolve(root, "electron/preload/settings-preload.ts")], outfile: resolve(outdir, "settings-preload.cjs") }),
  build({ ...common, entryPoints: [resolve(root, "electron/preload/activity-preload.ts")], outfile: resolve(outdir, "activity-preload.cjs") }),
  build({ ...common, entryPoints: [resolve(root, "electron/preload/speech-preload.ts")], outfile: resolve(outdir, "speech-preload.cjs") }),
  build({ ...common, entryPoints: [resolve(root, "electron/utility/codex-adapter-worker.ts")], outfile: resolve(outdir, "codex/codex-adapter-worker.cjs") }),
])

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

await import("./build-dictation.mjs")
