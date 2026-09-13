// GPU/signing-free production ASAR and user-readable notice verification.
import {cp, mkdir, readFile, rm, writeFile} from 'node:fs/promises'
import {resolve, join} from 'node:path'
import {createPackage} from '@electron/asar'
import {checkCandidate} from './check.mjs'
import {checkExternalNotices} from './check-notices.mjs'
import {digest} from './artwork.mjs'
const root = resolve(import.meta.dirname, '../..'), output = resolve(root, 'outputs/release-verification')
await mkdir(output, {recursive: true})
const stage = join(output, 'stage')
await rm(stage, {recursive: true, force: true}); await mkdir(stage)
for (const path of ['package.json', 'dist', 'dist-electron']) await cp(join(root, path), join(stage, path), {recursive: true})
const asar = join(output, 'app.asar')
await createPackage(stage, asar)
const checks = await checkCandidate(asar)
await cp(join(root, 'dist-notices/licenses'), join(output, 'licenses'), {recursive: true})
await checkExternalNotices(join(output, 'licenses'))
const rejected = []
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
const result = {checks, asar, sha256: digest(await readFile(asar)), negativeFixturesRejected: rejected, externalNoticeNegativeRejected: rejectedExternal, nativeInstallation: 'NOT RUN'}
await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result, null, 2))
