// External resources make notices readable without an ASAR reader, on every platform.
import {cp, mkdir, readFile, rm} from 'node:fs/promises'
import {resolve} from 'node:path'
import {requiredNotices} from './licenses.mjs'
const root = resolve(import.meta.dirname, '../..'), target = resolve(root, 'dist-notices/licenses')
await rm(resolve(root, 'dist-notices'), {recursive: true, force: true})
await mkdir(target, {recursive: true})
for (const [name, source] of Object.entries(requiredNotices)) await cp(resolve(root, source), resolve(target, name))
for (const [folder, source] of [['renderer', 'dist/licenses'], ['desktop', 'dist-electron/licenses']]) {
  // A desktop-only development build may precede the first renderer build.
  try { await readFile(resolve(root, source, 'inventory.json')) }
  catch { if (folder === 'renderer' && !process.argv.includes('--production')) continue; throw Error('Build renderer before production Electron notices') }
  await cp(resolve(root, source), resolve(target, folder), {recursive: true})
}
for (const [source, name] of [['LICENSE', 'Electron-LICENSE.txt'], ['LICENSES.chromium.html', 'LICENSES.chromium.html']]) {
  await cp(resolve(root, 'node_modules/electron/dist', source), resolve(target, name))
}
