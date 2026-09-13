import { APP_NAME, BUNDLE_ID } from "../../electron/shared/app-identity.mjs"
import { extractFile, listPackage } from '@electron/asar'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runtimeAssetPaths } from './runtime-assets.mjs'

const root = resolve(import.meta.dirname, '../..')
export async function checkCandidate(asar) {
  const files = listPackage(asar).map(p => p.replaceAll('\\', '/').replace(/^\//, ''))
  const json = path => JSON.parse(extractFile(asar, path).toString('utf8'))
  if (json('package.json').productName !== APP_NAME) throw new Error('Packaged app still shares the regular product identity')
  const catalog = json('dist/characters/catalog.json')
  const expected = ['gpichan/character.json']
  if (JSON.stringify(catalog.characters) !== JSON.stringify(expected)) throw new Error('Unexpected built-in characters')
  const mode = json('dist-electron/build-mode.json')
  if (!mode.production || mode.setupSmoke) throw new Error('Not a production build')
  const needed = await runtimeAssetPaths(resolve(root, 'public/characters'))
  for (const path of needed) {
    const packaged = extractFile(asar, 'dist/characters/' + path)
    const source = await readFile(resolve(root, 'public/characters', path))
    if (!packaged.equals(source)) throw new Error(`Runtime asset differs from source: ${path}`)
  }
  const allowedAssets = new Set(needed.flatMap(p => {
    const parts = p.split('/'); return parts.map((_, i) => 'dist/characters/' + parts.slice(0, i + 1).join('/'))
  }))
  for (const path of files) {
    if (!/^(package\.json|dist(?:\/|$)|dist-electron(?:\/|$))/.test(path)) throw new Error(`Unexpected app content: ${path}`)
    if (/\.(map|pyc)$/.test(path)) throw new Error(`Development artifact shipped: ${path}`)
    if (path.startsWith('dist/characters/') && !allowedAssets.has(path)) throw new Error(`Unreferenced artwork shipped: ${path}`)
  }
  const packages = []
  for (const prefix of ['dist/licenses', 'dist-electron/licenses']) {
    for (const name of ['PROJECT-LICENSE.txt', 'Anime2.5DRig-LICENSE.txt', 'ARTWORK-NOTICE.md']) extractFile(asar, `${prefix}/${name}`)
    for (const pkg of json(`${prefix}/inventory.json`)) {
      if (!['MIT', 'BSD-2-Clause', 'BSD-3-Clause', '(MIT AND Zlib)'].includes(pkg.license)) throw new Error(`Review license for ${pkg.name}: ${pkg.license}`)
      for (const notice of pkg.notices) if (!extractFile(asar, `${prefix}/${notice}`).length) throw new Error(`Empty notice: ${notice}`)
      packages.push(`${pkg.name}@${pkg.version}`)
    }
  }
  return { status: 'structure-verified', characters: expected, runtimeFiles: needed.length, packages: [...new Set(packages)].sort(), developmentAssets: 0 }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: npm run release:check -- <app.asar>')
  console.log(JSON.stringify(await checkCandidate(resolve(process.argv[2])), null, 2))
}
