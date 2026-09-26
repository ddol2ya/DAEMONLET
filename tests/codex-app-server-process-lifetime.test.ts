import { expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { build } from "esbuild"

it("stops owned observer/chat transports with blocked writes without leaking children", async () => {
  const root = await mkdtemp(join(tmpdir(), "jsonl-process-test-"))
  try {
    const outfile = join(root, "owned.mjs")
    await build({ entryPoints: [resolve("tests/fixtures/app-server/owned-process-lifetime.ts")], outfile, bundle: true, platform: "node", format: "esm", logLevel: "silent" })
    const result = await promisify(execFile)(process.execPath, ["--unhandled-rejections=strict", outfile], { timeout: 4000 })
    expect(result.stdout.trim()).toBe("owned-process-lifetime:passed")
    expect(result.stderr).toBe("")
  } finally { await rm(root, { recursive: true, force: true }) }
})
