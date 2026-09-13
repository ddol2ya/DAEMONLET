import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {runtimeAssetPaths} from './runtime-assets.mjs'

export const CC_BY_SHA256 = '9ba9550ad48438d0836ddab3da480b3b69ffa0aac7b7878b5a0039e7ab429411'
export const digest = bytes => createHash('sha256').update(bytes).digest('hex')
export async function gpichanPackNotice(root, scope) {
  const read = async path => (await readFile(resolve(root, path), 'utf8')).replaceAll('\r\n', '\n')
  const paths = scope.files.filter(f => f.path.startsWith('public/characters/gpichan/')).map(f => f.path.slice('public/characters/gpichan/'.length))
  return [await read('distribution/ARTWORK-NOTICE.md'), await read('distribution/ARTWORK-LICENSE.md'),
    'Exact CC BY 4.0 artwork paths relative to this pack:\n' + paths.map(p => '- ' + p).join('\n'),
    'This pack contains only the listed subset of the repository artwork. The complete repository inventory is available at https://github.com/ddol2ya/DAEMONLET/blob/main/distribution/ARTWORK-SCOPE.json . Source-document relative references above refer to the repository, not extra required pack files. Both legal texts follow here.',
    'Project nonvisual files — MIT:\n' + await read('LICENSE'),
    'CC BY 4.0 — unmodified official full text:\n' + await read('distribution/licenses/CC-BY-4.0.txt')].join('\n\n') + '\n'
}
export async function verifyArtwork(root) {
  const scope = JSON.parse(await readFile(resolve(root, 'distribution/ARTWORK-SCOPE.json'), 'utf8'))
  if (scope.license !== 'CC-BY-4.0' || scope.schemaVersion !== 1 || !Array.isArray(scope.files)) throw Error('Invalid artwork scope')
  const expected = (await runtimeAssetPaths(resolve(root, 'public/characters'))).filter(p => /\.(png|psd|jpe?g|webp)$/i.test(p)).map(p => 'public/characters/' + p).concat('docs/images/gpichan.png').sort()
  if (JSON.stringify(scope.files.map(f => f.path).sort()) !== JSON.stringify(expected) || expected.some(p => !p.startsWith('public/characters/gpichan/') && p !== 'docs/images/gpichan.png')) throw Error('Artwork scope differs from selected Gpichan visual assets')
  for (const f of scope.files) if (digest(await readFile(resolve(root, f.path))) !== f.sha256) throw Error('Artwork differs from reviewed scope: ' + f.path)
  if (digest(await readFile(resolve(root, 'distribution/licenses/CC-BY-4.0.txt'))) !== CC_BY_SHA256) throw Error('Official CC BY legal text differs')
  const notice = (await readFile(resolve(root, 'public/characters/gpichan/LICENSE.txt'), 'utf8')).replaceAll('\r\n', '\n')
  if (notice !== await gpichanPackNotice(root, scope)) throw Error('Gpichan pack attribution/license differs or is incomplete')
  return scope
}
