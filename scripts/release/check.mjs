import { APP_NAME, BUNDLE_ID } from "../../electron/shared/app-identity.mjs"
import { extractFile, listPackage } from '@electron/asar'
import { readFile } from 'node:fs/promises'
import { resolve, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import {assertSameSource} from './validation.mjs'
import { runtimeAssetPaths } from './runtime-assets.mjs'
import { requiredNotices } from './licenses.mjs'
import { verifyArtwork, digest } from './artwork.mjs'

const root = resolve(import.meta.dirname, '../..')
export async function checkCandidate(asar) {
  await verifyArtwork(root)
  const files = listPackage(asar).map(p => p.replaceAll('\\', '/').replace(/^\//, ''))
  // @electron/asar resolves member components with the host path separator.
  const extract = path => extractFile(asar, normalize(path))
  const json = path => JSON.parse(extract(path).toString('utf8'))
  if (json('package.json').productName !== APP_NAME) throw new Error('Packaged app still shares the regular product identity')
  assertSameSource(json('dist/build-source.json'), json('dist-electron/build-source.json'))
  const catalog = json('dist/characters/catalog.json')
  const expected = ['gpichan/character.json']
  if (JSON.stringify(catalog.characters) !== JSON.stringify(expected)) throw new Error('Unexpected built-in characters')
  const mode = json('dist-electron/build-mode.json')
  if (!mode.production || mode.setupSmoke) throw new Error('Not a production build')
  const graph = json('dist-electron/bundle-inputs.json')
  if (graph.production !== true || !Array.isArray(graph.inputs) || !graph.inputs.includes('electron/main/side-chat/SideChatBackend.ts')
    || graph.inputs.some(path => typeof path !== 'string' || /(?:Smoke|fixture|tests\/|scripts\/side-chat|runtime-patches)/i.test(path))) throw new Error('Unverified production input graph')
  const main = extract('dist-electron/main.cjs').toString('utf8')
  if (['fresh-approval-four-submissions', 'user-authorized-six-requests', 'private-official-answers', 'DAEMONLET_CHAT_SMOKE', 'readOnlySource', 'SOURCE_RUNTIME_UNSUPPORTED'].some(marker => main.includes(marker))) throw new Error('Side chat QA or custom code shipped')
  for (const required of ['dist/activity-bubble.html', 'dist-electron/activity-preload.cjs', 'dist/characters/gpichan/persona.json']) if (!files.includes(required)) throw new Error('Missing side chat runtime asset: ' + required)
  if (files.includes('dist/side-chat.html') || files.includes('dist-electron/side-chat-preload.cjs')) throw new Error('Standalone chat surface shipped')
  const needed = await runtimeAssetPaths(resolve(root, 'public/characters'))
  for (const path of needed) {
    const packaged = extract('dist/characters/' + path)
    const source = await readFile(resolve(root, 'public/characters', path))
    if (!packaged.equals(source)) throw new Error(`Runtime asset differs from source: ${path}`)
  }
  const allowedAssets = new Set(needed.flatMap(p => {
    const parts = p.split('/'); return parts.map((_, i) => 'dist/characters/' + parts.slice(0, i + 1).join('/'))
  }))
  for (const path of files) {
    if (!/^(package\.json|dist(?:\/|$)|dist-electron(?:\/|$))/.test(path)) throw new Error(`Unexpected app content: ${path}`)
    if (/\.(map|pyc|safetensors|ckpt|pt|pth|onnx|gguf)$|(^|\/)(node_modules|outputs|__pycache__)(\/|$)/i.test(path)) throw new Error(`Development artifact shipped: ${path}`)
    if (path.startsWith('dist/characters/') && !allowedAssets.has(path)) throw new Error(`Unreferenced artwork shipped: ${path}`)
  }
  const packages = []
  for (const prefix of ['dist/licenses', 'dist-electron/licenses']) {
    for (const [name, source] of Object.entries(requiredNotices)) {
      const bytes = extract(`${prefix}/${name}`)
      if (!bytes.length || !bytes.equals(await readFile(resolve(root, source)))) throw new Error(`Missing or altered notice: ${prefix}/${name}`)
    }
    // Build inventory and package files must match; removal of an inventory entry is not a bypass.
    if (!extract(`${prefix}/inventory.json`).equals(await readFile(resolve(root, prefix, 'inventory.json')))) throw Error('License inventory differs from build')
    for (const pkg of json(`${prefix}/inventory.json`)) {
      if (!['MIT', 'BSD-2-Clause', 'BSD-3-Clause', '(MIT AND Zlib)'].includes(pkg.license)) throw new Error(`Review license for ${pkg.name}: ${pkg.license}`)
      if (!pkg.notices.length) throw Error(`Missing dependency notices: ${pkg.name}`)
      for (const notice of pkg.notices) {
        if (!/^[\w@.+-]+\/[\w.-]+$/.test(notice)) throw Error('Invalid notice path')
        const bytes = extract(`${prefix}/${notice}`)
        if (!bytes.length || digest(bytes) !== pkg.noticeHashes?.[notice]) throw new Error(`Empty or altered notice: ${notice}`)
      }
      packages.push(`${pkg.name}@${pkg.version}`)
    }
  }
  return { status: 'structure-verified', characters: expected, runtimeFiles: needed.length, packages: [...new Set(packages)].sort(), developmentAssets: 0, productionInputs: graph.inputs.length, sideChatQaExcluded: true }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: npm run release:check -- <app.asar>')
  console.log(JSON.stringify(await checkCandidate(resolve(process.argv[2])), null, 2))
}
