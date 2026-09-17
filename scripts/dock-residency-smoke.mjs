import { build } from 'esbuild'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import electron from 'electron'
if (process.platform !== 'darwin') throw Error('Dock residency smoke requires macOS')
const root = resolve(import.meta.dirname, '..'), stage = await mkdtemp(join(tmpdir(), 'daemonlet-dock-smoke-'))
const output = resolve(process.argv[2] ?? 'outputs/dock-residency-smoke')
try {
  await mkdir(output, { recursive: true })
  await build({ entryPoints: [join(root, 'tests/smoke/dock-residency-electron.ts')], outfile: join(stage, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' })
  const env = { ...process.env, DAEMONLET_DOCK_PROFILE: join(stage, 'profile'), DAEMONLET_DOCK_RESULT: join(output, 'result.json') }; delete env.ELECTRON_RUN_AS_NODE
  await promisify(execFile)(electron, [join(stage, 'main.cjs')], { env, timeout: 30000 })
  console.log(await readFile(join(output, 'result.json'), 'utf8'))
} finally { await rm(stage, { recursive: true, force: true }) }
