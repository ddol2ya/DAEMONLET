import {afterEach, describe, expect, it} from 'vitest'
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {createValidation, recordCheck, verifyValidation, assertSameSource} from '../scripts/release/validation.mjs'
const folders: string[] = []
afterEach(async () => { await Promise.all(folders.splice(0).map(p => rm(p, {recursive: true, force: true}))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'daemonlet-validation-')); folders.push(root)
  await writeFile(join(root, 'app.zip'), 'real candidate bytes'); await writeFile(join(root, 'check.log'), 'executed synthetic verification\n')
  const source = {sourceCommit: 'a'.repeat(40), sourceTreeSha256: 'b'.repeat(64), workingTreeHasChanges: false}
  const record = await createValidation({root, source, appVersion: '0.7.0', artifacts: [{file: 'app.zip', kind: 'portableZip'}]})
  return {root, source, record}
}
const pass = async (record: any, root: string) => recordCheck(record, root, {kind: 'asar', status: 'PASS', procedure: 'synthetic checker', evidence: ['check.log']})
describe('candidate evidence boundaries', () => {
  it('initializes all checks as NOT_RUN and fails a required gate', async () => {
    const {record, root} = await fixture()
    expect(record.checks.every((c: any) => c.status === 'NOT_RUN')).toBe(true)
    await expect(verifyValidation(record, root, {required: ['asar']})).rejects.toThrow('Required check')
  })
  it('accepts executed evidence and preserves the captured SHA independently of HEAD', async () => {
    const {record, root, source} = await fixture(); await pass(record, root)
    await expect(verifyValidation(record, root, {required: ['asar']})).resolves.toMatchObject({completed: ['asar']})
    expect(record.sourceCommit).toBe(source.sourceCommit)
    await expect(verifyValidation(record, root, {source: {...source, sourceCommit: 'c'.repeat(40)}})).rejects.toThrow('source mismatch')
  })
  it.each(['replacement', 'same-size'])('rejects artifact mutation: %s', async mode => {
    const {record, root} = await fixture(); await pass(record, root)
    const before = await readFile(join(root, 'app.zip'))
    await writeFile(join(root, 'app.zip'), mode === 'same-size' ? Buffer.alloc(before.length, 65) : 'replacement')
    await expect(verifyValidation(record, root)).rejects.toThrow('Artifact hash mismatch')
  })
  it.each(['missing', 'empty', 'altered'])('rejects %s execution evidence', async mode => {
    const {record, root} = await fixture(); await pass(record, root)
    if (mode === 'missing') await rm(join(root, 'check.log')); else await writeFile(join(root, 'check.log'), mode === 'empty' ? '' : 'altered')
    await expect(verifyValidation(record, root)).rejects.toThrow()
  })
  it('rejects mixed source, candidate ID and final hash even for the same version', async () => {
    const {record, root} = await fixture(); await pass(record, root)
    for (const field of ['sourceCommit', 'sourceTreeSha256', 'candidateId']) {
      const mixed = structuredClone(record); mixed.checks.find((c: any) => c.kind === 'asar')[field] = 'wrong'
      await expect(verifyValidation(mixed, root)).rejects.toThrow('different candidate')
    }
    const mixed = structuredClone(record); mixed.checks.find((c: any) => c.kind === 'asar').artifacts[0].sha256 = 'c'.repeat(64)
    await expect(verifyValidation(mixed, root)).rejects.toThrow('different candidate')
  })
  it('rejects missing check metadata and unsupported N/A without reason', async () => {
    const {record, root} = await fixture(); await pass(record, root)
    delete record.checks.find((c: any) => c.kind === 'asar').evidence
    await expect(verifyValidation(record, root)).rejects.toThrow('lacks')
    const {record: other} = await fixture(); other.checks[0] = {kind: 'unit', status: 'N/A'}
    await expect(verifyValidation(other, root)).rejects.toThrow('reason')
  })
  it('rejects a renderer/desktop build from another source or dirty tree', () => {
    const source = {sourceCommit: 'a', sourceTreeSha256: 'b', workingTreeHasChanges: false}
    expect(() => assertSameSource(source, {...source, sourceTreeSha256: 'c'})).toThrow('source mismatch')
    expect(() => assertSameSource(source, {...source, workingTreeHasChanges: true})).toThrow('source mismatch')
  })
  it('required failed checks return a nonzero CLI exit code', async () => {
    const {record, root} = await fixture()
    await recordCheck(record, root, {kind: 'asar', status: 'FAIL', procedure: 'negative fixture', evidence: ['check.log']})
    const file = join(root, 'validation.json'); await writeFile(file, JSON.stringify(record))
    const result = spawnSync(process.execPath, ['scripts/release/validation-cli.mjs', 'verify', '--record', file, '--required', 'asar'], {encoding: 'utf8'})
    expect(result.status).not.toBe(0); expect(result.stderr).toContain('Required check did not pass')
  })
})
