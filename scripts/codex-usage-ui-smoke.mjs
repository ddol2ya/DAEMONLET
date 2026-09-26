// Account-free Electron fixture using production renderer, preload and controllers.
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import electron from 'electron'
const root = resolve(import.meta.dirname, '..'), output = resolve(process.argv[2] ?? 'outputs/codex-usage/ui')
await mkdir(output, { recursive: true })
const stage = await mkdtemp(join(tmpdir(), 'daemonlet-usage-ui-'))
try {
  const main = join(stage, 'main.cjs')
  await build({ entryPoints: [join(root, 'tests/smoke/codex-usage-electron.ts')], outfile: main, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' })
  const env = { ...process.env, USAGE_SMOKE_ROOT: root, USAGE_SMOKE_OUTPUT: output, USAGE_SMOKE_PROFILE: join(stage, 'user') }; delete env.ELECTRON_RUN_AS_NODE
  await new Promise((resolve, reject) => {
    const child = spawn(electron, [main], { env, stdio: 'inherit' })
    const timer = setTimeout(() => { child.kill(); reject(Error('Usage UI smoke deadline')) }, 60000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(Error('Usage UI smoke failed')) })
  })
  console.log(await readFile(join(output, 'result.json'), 'utf8'))
} finally { await rm(stage, { recursive: true, force: true }) }
