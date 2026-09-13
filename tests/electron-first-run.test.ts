import {afterEach, expect, it} from 'vitest'
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {requireElectronRuntime} from '../scripts/release/electron-runtime.mjs'
const folders: string[] = []
afterEach(async () => { await Promise.all(folders.splice(0).map(p => rm(p, {recursive: true, force: true}))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'daemonlet-first-run-')); folders.push(root)
  const base = join(root, 'node_modules/electron'); await mkdir(join(base, 'dist'), {recursive: true})
  await writeFile(join(base, 'package.json'), JSON.stringify({version: '43.4.0'}))
  return {root, base}
}
it('explains missing runtime and required explicit preparation without installing', async () => {
  const {root} = await fixture()
  await expect(requireElectronRuntime(root)).rejects.toThrow('npm run electron:install')
})
it('accepts a prepared runtime repeatedly, rejects absent/empty notices and mismatched version', async () => {
  const {root, base} = await fixture()
  for (const [file, text] of Object.entries({'path.txt': 'electron', 'dist/electron': 'fixture', 'dist/version': '43.4.0', 'dist/LICENSE': 'Electron notice', 'dist/LICENSES.chromium.html': 'Chromium notice'})) await writeFile(join(base, file), text)
  await requireElectronRuntime(root); await requireElectronRuntime(root)
  await rm(join(base, 'dist/LICENSE'))
  await expect(requireElectronRuntime(root)).rejects.toThrow('remove only node_modules/electron/dist/version')
  await writeFile(join(base, 'dist/LICENSE'), '')
  await expect(requireElectronRuntime(root)).rejects.toThrow('electron/dist/LICENSE')
  await writeFile(join(base, 'dist/LICENSE'), 'notice'); await writeFile(join(base, 'dist/version'), '0.0.0')
  await expect(requireElectronRuntime(root)).rejects.toThrow('matching version')
})

// A synthetic Windows run must never discover the real user's fixed broker.
it('isolates Windows smoke IPC by profile while preserving normal discovery', async () => {
  const {windowsDesktopPipe} = await import('../electron/shared/desktop-ipc-endpoint.mjs')
  const normal = windowsDesktopPipe('profile-a', {})
  const first = windowsDesktopPipe('profile-a', {ELECTRON_SMOKE_TEST: '1'})
  expect(first).not.toBe(normal)
  expect(first).not.toBe(windowsDesktopPipe('profile-b', {ELECTRON_SMOKE_TEST: '1'}))
  expect(windowsDesktopPipe('profile-b', {})).toBe(normal)
})
