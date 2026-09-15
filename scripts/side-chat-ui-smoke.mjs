import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import electron from 'electron'
const output = resolve(process.argv[2] ?? 'outputs/side-chat/ui')
await mkdir(output, { recursive: true })
const root = resolve(import.meta.dirname, '..'), stage = await mkdtemp(join(tmpdir(), 'daemonlet-chat-ui-'))
try {
  const main = join(stage, 'main.cjs')
  await build({ entryPoints: [join(root, 'tests/smoke/side-chat-electron.ts')], outfile: main, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' })
  const env = { ...process.env, DAEMONLET_CHAT_SMOKE_ROOT: root, DAEMONLET_CHAT_SMOKE_OUTPUT: output, DAEMONLET_CHAT_SMOKE_USER: join(stage, 'user') }; delete env.ELECTRON_RUN_AS_NODE
  await new Promise((resolve, reject) => {
    const child = spawn(electron, [main], { env, stdio: 'ignore' })
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(Error('UI smoke timeout')) }, 90000)
    child.once('error', e => { clearTimeout(timer); reject(e) }); child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(Error('UI smoke failed; see result.json')) })
  })
  console.log(await readFile(join(output, 'result.json'), 'utf8'))
} finally { await rm(stage, { recursive: true, force: true }) }
