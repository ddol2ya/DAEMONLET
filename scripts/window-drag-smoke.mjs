import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import electron from 'electron'

// Injected Electron mouse input, not a physical Option/Alt-drag test.
const root = resolve(import.meta.dirname, '..')
const output = resolve(process.argv[2] ?? 'outputs/window-drag-smoke')
const stage = await mkdtemp(join(tmpdir(), 'daemonlet-drag-smoke-'))
try {
  await mkdir(output, { recursive: true }); await mkdir(join(stage, 'renderer'))
  await writeFile(join(stage, 'renderer/pet.html'), '<!doctype html><body style="margin:0"><canvas width="300" height="300"></canvas><script type="module" src="/drag.js"></script>')
  const common = { bundle: true, logLevel: 'silent' }
  await build({ ...common, entryPoints: [join(root, 'tests/smoke/window-drag-renderer.ts')], outfile: join(stage, 'renderer/drag.js'), platform: 'browser', format: 'esm' })
  await build({ ...common, entryPoints: [join(root, 'electron/preload/pet-preload.ts')], outfile: join(stage, 'preload.cjs'), platform: 'node', format: 'cjs', external: ['electron'] })
  await build({ ...common, entryPoints: [join(root, 'tests/smoke/window-drag-electron.ts')], outfile: join(stage, 'main.cjs'), platform: 'node', format: 'cjs', external: ['electron'] })
  const env = { ...process.env, DAEMONLET_DRAG_STAGE: stage, DAEMONLET_DRAG_OUTPUT: output }; delete env.ELECTRON_RUN_AS_NODE
  let log = ''
  try {
    await new Promise((yes, no) => {
      const child = spawn(electron, [join(stage, 'main.cjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout.on('data', b => { log += b }); child.stderr.on('data', b => { log += b })
      const timer = setTimeout(() => child.kill(), 30000)
      child.once('error', e => { clearTimeout(timer); no(e) })
      child.once('exit', code => { clearTimeout(timer); code === 0 ? yes() : no(Error('Drag smoke failed: ' + code + '\n' + log)) })
    })
  } finally { await writeFile(join(output, 'electron.log'), log) }
  console.log(await readFile(join(output, 'result.json'), 'utf8'))
} finally { await rm(stage, { recursive: true, force: true }) }
