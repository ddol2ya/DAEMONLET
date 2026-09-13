// Extract a generated creator ZIP outside checkout, then use only its runtime tools.
import {open} from 'yauzl'
import {cp, mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises'
import {createWriteStream} from 'node:fs'
import {tmpdir} from 'node:os'
import {basename, dirname, join, resolve, relative} from 'node:path'
import {promisify} from 'node:util'
import {execFile} from 'node:child_process'
import {pipeline} from 'node:stream/promises'
import {digest} from './artwork.mjs'
import {createValidation, fileIdentity, recordCheck, saveValidation} from './validation.mjs'
const root = resolve(import.meta.dirname, '../..')
if (!process.argv[2]) throw Error('Usage: npm run creator:verify -- <actual creator.zip>')
const archive = resolve(process.argv[2]), target = await mkdtemp(join(tmpdir(), 'daemonlet-creator-verify-'))
const archiveBefore = await fileIdentity(dirname(archive), basename(archive))
const zip = await promisify(open)(archive, {lazyEntries: true, validateEntrySizes: true})
let bytes = 0, count = 0
await new Promise((done, reject) => {
  zip.on('error', reject); zip.on('end', done)
  zip.on('entry', async entry => {
    try {
      const name = entry.fileName
      if (!name.startsWith('create-pet-character/') || /[\\:]|(^|\/)\.{1,2}(\/|$)|\.(psd|png|jpe?g|webp|safetensors|ckpt|onnx|gguf|pyc)$|(^|\/)node_modules\//i.test(name)) throw Error('Unexpected creator archive entry')
      if (++count > 2000 || (bytes += entry.uncompressedSize) > 128 * 1024 ** 2 || entry.uncompressedSize > 32 * 1024 ** 2) throw Error('Creator archive bounds exceeded')
      const path = resolve(target, name)
      if (relative(target, path).startsWith('..')) throw Error('Creator path escapes extraction')
      if (name.endsWith('/')) await mkdir(path, {recursive: true})
      else { await mkdir(dirname(path), {recursive: true}); await pipeline(await promisify(zip.openReadStream.bind(zip))(entry), createWriteStream(path, {flags: 'wx'})) }
      zip.readEntry()
    } catch (error) { zip.close(); reject(error) }
  }); zip.readEntry()
})
const skill = join(target, 'create-pet-character'), runtime = join(skill, 'runtime')
for (const [name, source] of [['LICENSE.txt', 'LICENSE'], ['vendor/anime25drig/LICENSE', 'vendor/anime25drig/LICENSE'], ['vendor/anime25drig/UPSTREAM.md', 'vendor/anime25drig/UPSTREAM.md']]) {
  const actual = await readFile(join(skill, name))
  if (!actual.length || !actual.equals(await readFile(join(root, source)))) throw Error('Creator notice differs: ' + name)
}
const thirdParty = await readFile(join(skill, 'THIRD_PARTY_NOTICES.md'), 'utf8')
if (!thirdParty.includes('hakoniwa') || !thirdParty.includes('https://github.com/ddol2ya/DAEMONLET/')) throw Error('Creator third-party notice incomplete')
const env = {...process.env}; delete env.DAEMONLET_CREATOR_RUNTIME
const exec = promisify(execFile), npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
await exec(npm, ['ci', '--no-audit', '--no-fund'], {cwd: runtime, env, timeout: 300000, maxBuffer: 4 * 1024 ** 2, ...(process.platform === 'win32' ? {shell: true} : {})})
const {stdout} = await exec(process.execPath, [join(skill, 'scripts/creator.mjs'), 'check'], {cwd: target, env, timeout: 60000})
const check = JSON.parse(stdout)
if (check.runtime !== runtime || check.technicalReadiness !== 'runtime-ready' || check.licenseReview.status !== 'pending') throw Error('Standalone runtime or license status incorrect')
// Input artwork is a separate verification fixture, never part of the creator ZIP.
await cp(join(root, 'public/characters/gpichan'), join(target, 'input'), {recursive: true})
// The built-in legacy dialogue contains three unselected experimental pose IDs.
// Prepare only this temporary verification copy for the stricter pack validator;
// keep every original visual and the license notice byte-identical.
const character = JSON.parse(await readFile(join(target, 'input/character.json'), 'utf8'))
const poseIds = new Set(['base', ...await Promise.all(character.poses.map(async p => JSON.parse(await readFile(join(target, 'input', p), 'utf8')).id))])
const dialoguePath = join(target, 'input', character.dialogue), dialogue = JSON.parse(await readFile(dialoguePath, 'utf8'))
for (const key of ['poseTriggers', 'poseLines']) if (dialogue[key]) for (const id of Object.keys(dialogue[key])) if (!poseIds.has(id)) delete dialogue[key][id]
await writeFile(dialoguePath, JSON.stringify(dialogue, null, 2) + '\n')
await exec(process.execPath, [join(skill, 'scripts/creator.mjs'), 'export', '--character-root', join(target, 'input'), '--version', '0.7.0', '--output', join(target, 'gpichan.petchar')], {cwd: target, env, timeout: 120000, maxBuffer: 4 * 1024 ** 2})
const exported = await promisify(open)(join(target, 'gpichan.petchar'), {lazyEntries: true})
let noticePreserved = false
await new Promise((done, reject) => {
  exported.on('error', reject); exported.on('end', done)
  exported.on('entry', async entry => {
    try {
      if (entry.fileName === 'LICENSE.txt') {
        if (entry.uncompressedSize > 128 * 1024) throw Error('Unexpected notice size')
        const stream = await promisify(exported.openReadStream.bind(exported))(entry), chunks = []
        for await (const chunk of stream) chunks.push(chunk)
        noticePreserved = Buffer.concat(chunks).equals(await readFile(join(root, 'public/characters/gpichan/LICENSE.txt')))
      }
      exported.readEntry()
    } catch (error) { exported.close(); reject(error) }
  }); exported.readEntry()
})
if (!noticePreserved) throw Error('Exported Gpichan attribution/license was not preserved')
const python = env.DAEMONLET_CREATOR_PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
await exec(python, ['-c', 'import importlib.util; from pathlib import Path; p=Path("scripts/characters/lib/prepare.py"); s=importlib.util.spec_from_file_location("prepare",p); m=importlib.util.module_from_spec(s); s.loader.exec_module(m)'], {cwd: runtime, env, timeout: 60000})
const {stdout: buildOutput} = await exec(process.execPath, ['--input-type=module', '-e', "import {build} from 'esbuild'; await build({entryPoints:['src/main.tsx'],bundle:true,write:false,outdir:'verification-build',external:['util'],loader:{'.png':'dataurl','.svg':'dataurl'},logLevel:'silent'}); console.log('renderer-source-bundled')"], {cwd: runtime, env, timeout: 60000, maxBuffer: 4 * 1024 ** 2})
const result = {status: 'creator-extracted-verified', archive, sha256: digest(await readFile(archive)), extractedTo: target, files: count, bytes, runtimeCheck: check.technicalReadiness, licenseReview: check.licenseReview.status, export: join(target, 'gpichan.petchar'), exportSha256: digest(await readFile(join(target, 'gpichan.petchar'))), fixturePreparation: 'Only unselected dialogue pose references removed from temporary copy; original artwork and notice preserved', pythonHelpers: 'loaded', renderer: buildOutput.trim(), inferenceRun: false}
await mkdir(join(root, 'outputs/release-verification'), {recursive: true})
await writeFile(join(root, 'outputs/release-verification/creator-result.json'), JSON.stringify(result, null, 2) + '\n')
if (JSON.stringify(archiveBefore) !== JSON.stringify(await fileIdentity(dirname(archive), basename(archive)))) throw Error('Creator archive changed during verification')
const validation = await createValidation({root: dirname(archive), source: JSON.parse(await readFile(join(skill, 'build-source.json'), 'utf8')), appVersion: JSON.parse(await readFile(join(runtime, 'package.json'), 'utf8')).version, artifacts: [{file: basename(archive), kind: 'creatorZip'}]})
await writeFile(join(dirname(archive), 'creator-extraction-result.json'), JSON.stringify(result, null, 2) + '\n', {mode: 0o600})
await recordCheck(validation, dirname(archive), {kind: 'creatorExtraction', status: 'PASS', procedure: ['npm', 'run', 'creator:verify', '--', basename(archive)], evidence: ['creator-extraction-result.json']})
await saveValidation(dirname(archive), validation, 'creator-validation.json')
console.log(JSON.stringify(result, null, 2))
