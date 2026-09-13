import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { verifyArtwork, digest } from './artwork.mjs'

export const requiredNotices = {
  'PROJECT-LICENSE.txt': 'LICENSE',
  'Anime2.5DRig-LICENSE.txt': 'vendor/anime25drig/LICENSE',
  'Anime2.5DRig-MODIFICATIONS.md': 'vendor/anime25drig/UPSTREAM.md',
  'THIRD_PARTY_NOTICES.md': 'THIRD_PARTY_NOTICES.md',
  'ARTWORK-NOTICE.md': 'distribution/ARTWORK-NOTICE.md',
  'ARTWORK-LICENSE.md': 'distribution/ARTWORK-LICENSE.md',
  'ARTWORK-SCOPE.json': 'distribution/ARTWORK-SCOPE.json',
  'CC-BY-4.0.txt': 'distribution/licenses/CC-BY-4.0.txt',
}

const root = resolve(import.meta.dirname, '../..')
export async function writeLicenseBundle(directory, modulePaths) {
  await verifyArtwork(root)
  await mkdir(directory, { recursive: true })
  const packages = new Map()
  for (const input of modulePaths) {
    if (!input.replaceAll('\\', '/').includes('node_modules/')) continue
    let path = dirname(resolve(root, input.split('?')[0]))
    while (path !== dirname(path)) {
      let pkg
      try { pkg = JSON.parse(await readFile(join(path, 'package.json'), 'utf8')) } catch {}
      if (pkg?.name && pkg?.version) { packages.set(path, pkg); break }
      path = dirname(path)
    }
  }
  const inventory = []
  for (const [path, pkg] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
    const notices = (await readdir(path)).filter(name => /^(licen[sc]e|copying|notice|copyright)([._-]|$)/i.test(name))
    if (!notices.length) throw new Error(`Missing license text for bundled ${pkg.name}@${pkg.version}`)
    const folder = `${pkg.name.replaceAll('/', '__')}@${pkg.version}`
    await mkdir(join(directory, folder), { recursive: true })
    for (const name of notices) await copyFile(join(path, name), join(directory, folder, name))
    const noticeHashes = Object.fromEntries(await Promise.all(notices.map(async name => [`${folder}/${name}`, digest(await readFile(join(path, name)))])))
    inventory.push({ name: pkg.name, version: pkg.version, license: pkg.license ?? 'UNDECLARED', notices: notices.map(name => `${folder}/${name}`), noticeHashes })
  }
  for (const [name, source] of Object.entries(requiredNotices)) await copyFile(join(root, source), join(directory, name))
  await writeFile(join(directory, 'inventory.json'), JSON.stringify(inventory, null, 2) + '\n')
  return inventory
}
