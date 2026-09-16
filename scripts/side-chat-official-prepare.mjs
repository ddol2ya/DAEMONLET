import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const stage = await mkdtemp(join(tmpdir(), 'daemonlet-official-prepare-code-'))
try {
  const entry = join(stage, 'prepare.mjs')
  await build({ entryPoints: [resolve(import.meta.dirname, 'side-chat/official-prepare.ts')], bundle: true, platform: 'node', format: 'esm', outfile: entry, logLevel: 'silent' })
  await import(pathToFileURL(entry).href)
} finally { await rm(stage, { recursive: true, force: true }) }
