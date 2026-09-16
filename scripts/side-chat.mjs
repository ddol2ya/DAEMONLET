import { build } from "esbuild"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const entries = { backend: "backend-probe", tools: "tool-policy-probe", startup: "official-startup-probe", prepare: "official-prepare" }
const command = process.argv[2]
if (!Object.hasOwn(entries, command)) throw Error("Choose backend, tools, startup, or prepare")
process.argv.splice(2, 1)
const stage = await mkdtemp(join(tmpdir(), "daemonlet-chat-check-"))
try {
  const output = join(stage, "check.mjs")
  await build({ entryPoints: [resolve(import.meta.dirname, "side-chat", entries[command] + ".ts")], outfile: output, bundle: true, platform: "node", format: "esm", logLevel: "silent" })
  await import(pathToFileURL(output).href)
} finally { await rm(stage, { recursive: true, force: true }) }
