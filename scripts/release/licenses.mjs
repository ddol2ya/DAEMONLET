import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
export async function writeLicenseBundle(directory, modulePaths) {
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
    inventory.push({ name: pkg.name, version: pkg.version, license: pkg.license ?? 'UNDECLARED', notices: notices.map(name => `${folder}/${name}`) })
  }
  await copyFile(join(root, 'LICENSE'), join(directory, 'PROJECT-LICENSE.txt'))
  await copyFile(join(root, 'vendor/anime25drig/LICENSE'), join(directory, 'Anime2.5DRig-LICENSE.txt'))
  await copyFile(join(root, 'vendor/anime25drig/UPSTREAM.md'), join(directory, 'Anime2.5DRig-MODIFICATIONS.md'))
  await copyFile(join(root, 'distribution/ARTWORK-NOTICE.md'), join(directory, 'ARTWORK-NOTICE.md'))
  await writeFile(join(directory, 'inventory.json'), JSON.stringify(inventory, null, 2) + '\n')
  return inventory
}
