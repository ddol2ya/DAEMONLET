import { build } from "esbuild"
import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { requireElectronRuntime } from "./release/electron-runtime.mjs"
import electron from "electron"

const root = resolve(import.meta.dirname, "..")
await requireElectronRuntime(root)
const temporary = await mkdtemp(join(tmpdir(), "daemonlet-language-runner-"))
try {
  const entry = join(temporary, "language-ui-smoke.cjs")
  await build({ entryPoints: [join(root, "tests/fixtures/language-ui-smoke.ts")], outfile: entry, bundle: true, platform: "node", format: "cjs", external: ["electron"] })
  const child = spawn(electron, [entry], { cwd: root, stdio: "inherit", shell: false })
  const timer = setTimeout(() => child.kill("SIGTERM"), 60_000)
  try {
    const code = await new Promise((done, reject) => { child.once("error", reject); child.once("exit", done) })
    if (code !== 0) throw new Error(`Language UI smoke exited with ${code}`)
  } finally { clearTimeout(timer) }
} finally { await rm(temporary, { recursive: true, force: true }) }
