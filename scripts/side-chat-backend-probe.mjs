import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const stage = await mkdtemp(join(tmpdir(), 'daemonlet-backend-probe-code-'))
try {
  const entry = join(stage, 'probe.mjs')
  await build({ entryPoints: [resolve(import.meta.dirname, 'side-chat/backend-probe.ts')], bundle: true, platform: 'node', format: 'esm', outfile: entry, logLevel: 'silent' })
  await import(pathToFileURL(entry).href)
} finally { await rm(stage, { recursive: true, force: true }) }
