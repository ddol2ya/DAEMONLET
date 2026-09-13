// Copied into the private installer build project; not installed with the app.
import { build, Platform, Arch } from 'electron-builder'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import {basename, relative, join} from 'node:path'

import {createValidation, recordCheck, saveValidation} from './validation.mjs'

if (process.platform !== 'win32') throw new Error('Build and test the NSIS installer on Windows')
const root = import.meta.dirname
process.chdir(root)
const manifest = JSON.parse(await readFile(join(root, 'payload.json'), 'utf8'))
async function verify() {
  const actual = []
  async function walk(path, prefix = '') {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(join(path, entry.name), prefix + entry.name + '/')
      else if (entry.isFile()) actual.push(prefix + entry.name)
      else throw new Error('Unexpected payload link or special file')
    }
  }
  await walk(join(root, 'runtime'))
  if (JSON.stringify(actual.sort()) !== JSON.stringify(manifest.files.map(f => f.path).sort())) throw new Error('Installer payload file list changed')
  for (const file of manifest.files) {
    const hash = createHash('sha256')
    for await (const bytes of createReadStream(join(root, 'runtime', file.path))) hash.update(bytes)
    if (hash.digest('hex') !== file.sha256) throw new Error('Installer payload hash mismatch: ' + file.path)
  }
}
await verify()
const config = JSON.parse(await readFile(join(root, 'electron-builder.json'), 'utf8'))
const artifacts = await build({ projectDir: root, prepackaged: join(root, 'runtime'),
  targets: Platform.WINDOWS.createTarget('nsis', Arch.x64), config, publish: 'never' })
await verify()
const files = []
for (const file of artifacts.filter(file => file.endsWith('.exe'))) {
  const bytes = await readFile(file)
  if (bytes.subarray(0,2).toString() !== 'MZ') throw new Error('Invalid Windows executable')
  files.push({ path: file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
}
if (files.length !== 1) throw new Error('Expected exactly one installer EXE')
await writeFile(join(root, 'installer-build-result.json'), JSON.stringify({ schemaVersion: 1, kind: 'windows-installer-build', source: manifest.source, appVersion: manifest.appVersion, files, runtimeUnchanged: true, creatorToolsIncluded: false, signing: 'unsigned' }, null, 2) + '\n')
const validation = await createValidation({root, source: manifest.source, appVersion: manifest.appVersion, artifacts: files.map(f => ({file: relative(root, f.path).replaceAll('\\', '/'), kind: 'windowsInstallerExe'}))})
await recordCheck(validation, root, {kind: 'build', status: 'PASS', procedure: 'electron-builder NSIS; payload hashes checked before and after; not native installation', evidence: ['installer-build-result.json', 'payload.json']})
await saveValidation(root, validation)
console.log(JSON.stringify(files, null, 2))
