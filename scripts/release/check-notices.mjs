import {readFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {requiredNotices} from './licenses.mjs'
import {digest} from './artwork.mjs'
const root = resolve(import.meta.dirname, '../..')
export async function checkExternalNotices(directory) {
  for (const [name, source] of Object.entries(requiredNotices)) {
    const bytes = await readFile(resolve(directory, name))
    if (!bytes.length || !bytes.equals(await readFile(resolve(root, source)))) throw Error('Missing or altered external notice: ' + name)
  }
  for (const [name, source] of [['Electron-LICENSE.txt', 'LICENSE'], ['LICENSES.chromium.html', 'LICENSES.chromium.html']]) {
    const bytes = await readFile(resolve(directory, name))
    if (!bytes.length || !bytes.equals(await readFile(resolve(root, 'node_modules/electron/dist', source)))) throw Error('Runtime notice differs: ' + name)
  }
  for (const [folder, source] of [['renderer', 'dist/licenses'], ['desktop', 'dist-electron/licenses']]) {
    const inventory = await readFile(resolve(directory, folder, 'inventory.json'))
    if (!inventory.equals(await readFile(resolve(root, source, 'inventory.json')))) throw Error('External inventory differs')
    for (const pkg of JSON.parse(inventory)) for (const notice of pkg.notices) {
      if (!/^[\w@.+-]+\/[\w.-]+$/.test(notice)) throw Error('Invalid notice path')
      const bytes = await readFile(resolve(directory, folder, notice))
      if (!bytes.length || digest(bytes) !== pkg.noticeHashes?.[notice]) throw Error('Dependency notice differs: ' + notice)
    }
  }
  return {status: 'external-notices-verified'}
}
