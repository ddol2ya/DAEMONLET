// GPU/signing-free production ASAR and user-readable notice verification.
import {cp, mkdir, readFile, rm, writeFile} from 'node:fs/promises'
import {resolve, join} from 'node:path'
import {createPackage} from '@electron/asar'
import {checkCandidate} from './check.mjs'
import {checkExternalNotices} from './check-notices.mjs'
import {digest} from './artwork.mjs'
import {createValidation, readBuildSource, recordCheck, saveValidation} from './validation.mjs'
const root = resolve(import.meta.dirname, '../..'), output = resolve(root, 'outputs/release-verification')
await mkdir(output, {recursive: true})
const stage = join(output, 'stage')
await rm(stage, {recursive: true, force: true}); await mkdir(stage)
for (const path of ['package.json', 'dist', 'dist-electron']) await cp(join(root, path), join(stage, path), {recursive: true})
const asar = join(output, 'app.asar')
await createPackage(stage, asar)
const validation = await createValidation({root: output, source: await readBuildSource(root), appVersion: JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version, artifacts: [{file: 'app.asar', kind: 'asar'}]})
const checks = await checkCandidate(asar)
await cp(join(root, 'dist-notices/licenses'), join(output, 'licenses'), {recursive: true})
await checkExternalNotices(join(output, 'licenses'))
const rejected = []
const qaRejected = []
for (const [name, relative, mutate] of [
  ['qa-input', 'dist-electron/bundle-inputs.json', bytes => { const graph = JSON.parse(bytes); graph.inputs.push('scripts/side-chat/fixture-process.ts'); return JSON.stringify(graph) }],
  ['qa-sink', 'dist-electron/main.cjs', bytes => bytes + '\n/* private-official-answers */'],
]) {
  const path = join(stage, relative), original = await readFile(path)
  await writeFile(path, mutate(original.toString('utf8')))
  const fixture = join(output, name + '.asar'); await createPackage(stage, fixture)
  let failure
  try { await checkCandidate(fixture) } catch (error) { failure = error }
  await rm(fixture); await writeFile(path, original)
  if (!failure || !/input graph|QA or custom/.test(failure.message)) throw Error('QA artifact negative control was not rejected: ' + name)
  qaRejected.push(name)
}
const obsolete = join(stage, 'dist/side-chat.html'), obsoleteArchive = join(output, 'standalone-chat.asar')
await writeFile(obsolete, '<!doctype html><title>Obsolete standalone chat</title>', {flag: 'wx'})
await createPackage(stage, obsoleteArchive)
let rejectedStandalone = false
try { await checkCandidate(obsoleteArchive) } catch (error) { rejectedStandalone = /Standalone chat surface/.test(error.message) }
await rm(obsolete); await rm(obsoleteArchive)
if (!rejectedStandalone) throw Error('Standalone chat surface negative control was accepted')
qaRejected.push('standalone-chat')
// Real archives, not a mocked parser. Keep the good candidate untouched.
const path = join(stage, 'dist/licenses/CC-BY-4.0.txt'), original = await readFile(path)
for (const mode of ['missing', 'empty', 'altered']) {
  if (mode === 'missing') await rm(path)
  else await writeFile(path, mode === 'empty' ? '' : 'altered legal text')
  const fixture = join(output, mode + '.asar'); await createPackage(stage, fixture)
  let failure
  try { await checkCandidate(fixture) } catch (error) { failure = error }
  if (!failure || !/CC-BY-4.0/.test(failure.message)) throw Error('Notice negative fixture did not fail at the intended notice: ' + mode)
  rejected.push(mode); await rm(fixture); await writeFile(path, original)
}
const external = join(output, 'licenses/ARTWORK-NOTICE.md'), bytes = await readFile(external)
await writeFile(external, '')
let rejectedExternal = false
try { await checkExternalNotices(join(output, 'licenses')) } catch { rejectedExternal = true }
await writeFile(external, bytes)
if (!rejectedExternal) throw Error('Empty external notice was accepted')
const result = {checks, asar, sha256: digest(await readFile(asar)), negativeFixturesRejected: rejected, qaNegativeFixturesRejected: qaRejected, externalNoticeNegativeRejected: rejectedExternal, nativeInstallation: 'NOT RUN'}
await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n')
await recordCheck(validation, output, {kind: 'asar', status: 'PASS', procedure: 'npm run release:verify (production ASAR, scoped assets, external notices and negative fixtures)', evidence: ['result.json']})
await saveValidation(output, validation)
console.log(JSON.stringify(result, null, 2))
