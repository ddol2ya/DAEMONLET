import { build } from 'esbuild'
import { createWriteStream } from 'node:fs'
import { spawn } from 'node:child_process'
import { cp, mkdtemp, mkdir, readFile, rm, readdir, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import electron from 'electron'
const output = resolve(process.argv[2] ?? 'outputs/side-chat/ui')
await mkdir(output, { recursive: true })
const root = resolve(import.meta.dirname, '..'), stage = await mkdtemp(join(tmpdir(), 'daemonlet-chat-ui-'))
try {
  const main = join(stage, 'main.cjs'), fixtureDist = join(stage, 'renderer')
  await mkdir(fixtureDist)
  for (const name of await readdir(join(root, 'dist'))) if (name !== 'pet.html') await (process.platform === 'win32' ? cp(join(root, 'dist', name), join(fixtureDist, name), { recursive: true }) : symlink(join(root, 'dist', name), join(fixtureDist, name)))
  await writeFile(join(fixtureDist, 'pet.html'), '<!doctype html><html lang="ko"><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module" src="/bubble-pet.js"></script></body></html>')
  await build({ entryPoints: [join(root, 'tests/smoke/side-chat-pet.tsx')], outfile: join(fixtureDist, 'bubble-pet.js'), bundle: true, platform: 'browser', format: 'esm', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' })
  await build({ entryPoints: [join(root, 'tests/smoke/side-chat-electron.ts')], outfile: main, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent', plugins: [{ name: 'qa-preparation-metadata', setup(bundler) { bundler.onResolve({ filter: /SideChatPolicy$/ }, () => ({ path: join(root, 'tests/smoke/side-chat-setup-policy.ts') })) } }] })
  const env = { ...process.env, DAEMONLET_CHAT_SMOKE_ROOT: root, DAEMONLET_CHAT_SMOKE_FIXTURE_DIST: fixtureDist, DAEMONLET_CHAT_SMOKE_OUTPUT: output, DAEMONLET_CHAT_SMOKE_USER: join(stage, 'user') }; delete env.ELECTRON_RUN_AS_NODE
  await new Promise((resolve, reject) => {
    const log = createWriteStream(join(output, 'electron.log'))
    const child = spawn(electron, [main], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false })
    child.once('exit', () => log.end())
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(Error('UI smoke timeout')) }, 90000)
    child.once('error', e => { clearTimeout(timer); reject(e) }); child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(Error('UI smoke failed; see result.json')) })
  })
  console.log(await readFile(join(output, 'result.json'), 'utf8'))
} finally { await rm(stage, { recursive: true, force: true }) }
