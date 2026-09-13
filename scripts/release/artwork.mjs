import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {runtimeAssetPaths} from './runtime-assets.mjs'

export const CC_BY_SHA256 = '9ba9550ad48438d0836ddab3da480b3b69ffa0aac7b7878b5a0039e7ab429411'
export const digest = bytes => createHash('sha256').update(bytes).digest('hex')
export const CHARACTER_REFERENCE_COLLECTION = 'https://gall.dcinside.com/mgallery/board/view/?id=thesingularity&no=1150189'
export const iconPaths = ['electron/assets/icon-source/app-a2-rabbit.png', 'electron/assets/icon-source/menu-m2-rabbit.png', 'electron/assets/appIcon.icns', 'electron/assets/trayTemplate.png', 'electron/assets/trayTemplate@2x.png', 'electron/assets/trayTemplate.svg', 'public/favicon.svg'].sort()
export async function gpichanPackNotice(root, scope) {
  const read = async path => (await readFile(resolve(root, path), 'utf8')).replaceAll('\r\n', '\n')
  const paths = scope.files.filter(f => f.path.startsWith('public/characters/gpichan/')).map(f => f.path.slice('public/characters/gpichan/'.length))
  return [await read('distribution/ARTWORK-NOTICE.md'), await read('distribution/ARTWORK-LICENSE.md'),
    'Visual file paths relative to this pack (CC BY 4.0 covers provider-controlled contributions only; underlying community material is excluded and its terms are unverified):\n' + paths.map(p => '- ' + p).join('\n'),
    'This pack contains only the listed subset of the repository artwork. The complete repository inventory is available at https://github.com/ddol2ya/DAEMONLET/blob/main/distribution/ARTWORK-SCOPE.json . Source-document relative references above refer to the repository, not extra required pack files. Both legal texts follow here.',
    'Project nonvisual files — MIT:\n' + await read('LICENSE'),
    'CC BY 4.0 — unmodified official full text:\n' + await read('distribution/licenses/CC-BY-4.0.txt')].join('\n\n') + '\n'
}
export async function verifyArtwork(root) {
  const scope = JSON.parse(await readFile(resolve(root, 'distribution/ARTWORK-SCOPE.json'), 'utf8'))
  if (scope.license !== 'CC-BY-4.0' || scope.schemaVersion !== 1 || !Array.isArray(scope.files)) throw Error('Invalid artwork scope')
  if (scope.licenseScope !== 'provider-controlled-rights-only' ||
      scope.characterRights?.appliesTo !== 'files' ||
      scope.characterRights?.projectGrant !== 'additional-contributions-only' ||
      scope.characterRights?.underlyingMaterials?.includedInGrant !== false ||
      scope.characterRights?.underlyingMaterials?.status !== 'unverified' ||
      scope.characterRights?.underlyingMaterials?.license !== null ||
      scope.characterRights?.underlyingMaterials?.referenceCollection !== CHARACTER_REFERENCE_COLLECTION) throw Error('Artwork rights scope omits the reviewed underlying-material exclusion')
  const expected = (await runtimeAssetPaths(resolve(root, 'public/characters'))).filter(p => /\.(png|psd|jpe?g|webp)$/i.test(p)).map(p => 'public/characters/' + p).concat('docs/images/gpichan.png').sort()
  if (JSON.stringify(scope.files.map(f => f.path).sort()) !== JSON.stringify(expected) || expected.some(p => !p.startsWith('public/characters/gpichan/') && p !== 'docs/images/gpichan.png')) throw Error('Artwork scope differs from selected Gpichan visual assets')
  if (JSON.stringify(scope.icons?.map(f => f.path).sort()) !== JSON.stringify(iconPaths)) throw Error('Icon scope differs from selected project icons')
  for (const f of [...scope.files, ...scope.icons]) if (digest(await readFile(resolve(root, f.path))) !== f.sha256) throw Error('Artwork differs from reviewed scope: ' + f.path)
  const embedded = await readFile(resolve(root, 'electron/main/TrayIconData.ts'), 'utf8')
  for (const [name, path] of [['TRAY_TEMPLATE_PNG', 'electron/assets/trayTemplate.png'], ['TRAY_TEMPLATE_PNG_2X', 'electron/assets/trayTemplate@2x.png']]) {
    const payload = embedded.match(new RegExp(`export const ${name} = "([A-Za-z0-9+/=]+)"`))?.[1]
    if (!payload || digest(Buffer.from(payload, 'base64')) !== scope.icons.find(f => f.path === path)?.sha256) throw Error('Embedded icon differs from reviewed artwork: ' + name)
  }
  if (digest(await readFile(resolve(root, 'distribution/licenses/CC-BY-4.0.txt'))) !== CC_BY_SHA256) throw Error('Official CC BY legal text differs')
  const notice = (await readFile(resolve(root, 'public/characters/gpichan/LICENSE.txt'), 'utf8')).replaceAll('\r\n', '\n')
  if (notice !== await gpichanPackNotice(root, scope)) throw Error('Gpichan pack attribution/license differs or is incomplete')
  return scope
}
