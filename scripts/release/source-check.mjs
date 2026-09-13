import {execFileSync} from 'node:child_process'
import {lstat, readFile, realpath} from 'node:fs/promises'
import {isAbsolute, relative, resolve} from 'node:path'
import {runtimeAssetPaths} from './runtime-assets.mjs'
import {scanSourceText, sourcePathFindings} from './source-policy.mjs'
import {verifyArtwork} from './artwork.mjs'
const root = resolve(import.meta.dirname, '../..')
const git = args => execFileSync('git', args, {cwd: root, encoding: 'utf8'}).trim()
if (resolve(git(['rev-parse', '--show-toplevel'])) !== root) throw Error('Wrong repository root')
const files = [...new Set(git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean))]
const failures = [], privateMarkers = []
// Optional exact markers must live outside this checkout, never in public examples.
if (process.env.DAEMONLET_SOURCE_PRIVATE_RULES) {
  const path = await realpath(process.env.DAEMONLET_SOURCE_PRIVATE_RULES)
  const rel = relative(await realpath(root), path)
  if (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../')) throw Error('Private rules must be outside the checkout')
  const markers = JSON.parse(await readFile(path, 'utf8'))
  if (!Array.isArray(markers) || markers.some(s => typeof s !== 'string' || s.length < 4)) throw Error('Private rules must be an array of nonempty markers')
  privateMarkers.push(...markers)
}
const runtime = new Set((await runtimeAssetPaths(resolve(root, 'public/characters'))).map(p => 'public/characters/' + p))
for (const file of files) {
  failures.push(...sourcePathFindings(file))
  if (file.startsWith('public/characters/') && !runtime.has(file)) failures.push({path: file, line: 1, type: 'unselected-character'})
  const info = await lstat(resolve(root, file))
  if (!info.isFile()) { failures.push({path: file, line: 1, type: 'non-file'}); continue }
  if (info.size > 50 * 1024 * 1024) failures.push({path: file, line: 1, type: 'large-source-file'})
  if (!/\.(png|psd|icns|ico|jpe?g|webp)$/i.test(file)) failures.push(...scanSourceText(await readFile(resolve(root, file), 'utf8'), file, {privateMarkers}))
}
await verifyArtwork(root)
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
if (pkg.name !== 'daemonlet-for-codex' || pkg.productName !== 'Daemonlet for Codex') failures.push({path: 'package.json', line: 1, type: 'product-identity'})
console.log(JSON.stringify({files: files.length, runtimeAssets: runtime.size, failures}, null, 2))
if (!files.length || failures.length) process.exitCode = 1
