import {afterEach, describe, expect, it} from 'vitest'
import {cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises'
import {execFileSync, spawnSync} from 'node:child_process'
import {createWriteStream} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {pipeline} from 'node:stream/promises'
import {createPackage} from '@electron/asar'
import {ZipFile} from 'yazl'
import {createValidation, fileIdentity, recordCheck, sourceIdentity} from '../scripts/release/validation.mjs'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true}))) })
const A = {sourceCommit: 'a'.repeat(40), sourceTreeSha256: '1'.repeat(64), workingTreeHasChanges: false}
const B = {sourceCommit: 'b'.repeat(40), sourceTreeSha256: '2'.repeat(64), workingTreeHasChanges: false}
async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'daemonlet-validation-cli-')); roots.push(root)
  await mkdir(join(root, 'scripts/release'), {recursive: true}); await mkdir(join(root, 'outputs'))
  for (const file of ['validation-cli.mjs', 'validation.mjs', 'artifact-source.mjs']) await cp(resolve('scripts/release', file), join(root, 'scripts/release', file))
  await writeFile(join(root, '.gitignore'), 'outputs/\nnode_modules\n')
  await symlink(resolve('node_modules'), join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  await writeFile(join(root, 'source.txt'), 'tracked source A\n')
  await writeFile(join(root, 'package.json'), JSON.stringify({name: 'daemonlet-for-codex', version: '0.7.0', type: 'module'}))
  const git = (...args: string[]) => execFileSync('git', args, {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim()
  git('init', '-q'); git('config', 'user.name', 'Validation Test'); git('config', 'user.email', 'test@example.com')
  git('config', 'core.hooksPath', join(root, 'outputs/no-hooks')); git('config', 'commit.gpgSign', 'false'); git('config', 'core.autocrlf', 'false')
  git('add', '.'); git('commit', '-qm', 'fixture source')
  const cli = (...args: string[]) => spawnSync(process.execPath, ['scripts/release/validation-cli.mjs', ...args], {cwd: root, encoding: 'utf8', timeout: 30000})
  const json = async (file = 'outputs/validation.json') => JSON.parse(await readFile(join(root, file), 'utf8'))
  return {root, git, cli, json}
}
async function asar(root: string, name: string, source: unknown = A, version: unknown = '0.7.0', renderer: unknown = source) {
  const stage = join(root, 'outputs', name + '-stage')
  await mkdir(join(stage, 'dist'), {recursive: true}); await mkdir(join(stage, 'dist-electron'))
  await writeFile(join(stage, 'package.json'), JSON.stringify({name: 'daemonlet-for-codex', version}))
  if (source !== null) await writeFile(join(stage, 'dist-electron/build-source.json'), JSON.stringify(source))
  if (renderer !== null) await writeFile(join(stage, 'dist/build-source.json'), JSON.stringify(renderer))
  const path = join(root, 'outputs', name + '.asar'); await createPackage(stage, path); return path
}
async function zip(root: string, name: string, entries: Array<[string, Buffer]>) {
  const archive = new ZipFile()
  for (const [name, bytes] of entries) archive.addBuffer(bytes, name)
  archive.end(); await pipeline(archive.outputStream, createWriteStream(join(root, 'outputs', name)))
}
const init = (f: Awaited<ReturnType<typeof repository>>, ...artifacts: string[]) => f.cli('init', '--record', 'outputs/validation.json', ...artifacts.flatMap(a => ['--artifact', a]))

describe('init derives identity from actual artifacts', () => {
  it.each(['same version', 'different version'])('identifies real ZIP A after checkout B, with %s', async variant => {
    const f = await repository()
    const sourceA = await sourceIdentity(f.root)
    const path = await asar(f.root, 'A', sourceA)
    await zip(f.root, 'A.zip', [['Daemonlet.app/Contents/Resources/app.asar', await readFile(path)]])
    await mkdir(join(f.root, 'dist')); await mkdir(join(f.root, 'dist-electron'))
    for (const folder of ['dist', 'dist-electron']) await writeFile(join(f.root, folder, 'build-source.json'), JSON.stringify(B))
    await writeFile(join(f.root, 'package.json'), JSON.stringify({version: variant === 'same version' ? '0.7.0' : '2.0.0'}))
    f.git('add', '.'); f.git('commit', '-qm', 'checkout B')
    const result = init(f, 'macosZip:A.zip')
    expect(result.status, result.stderr).toBe(0)
    const record = await f.json()
    expect(record).toMatchObject({...sourceA, appVersion: '0.7.0'})
    expect(record.sourceCommit).not.toBe(f.git('rev-parse', 'HEAD'))
    expect(record.checks.every((c: any) => c.status === 'NOT_RUN')).toBe(true)
  })
  it('identifies a bare ASAR without checkout build outputs', async () => {
    const f = await repository(); await asar(f.root, 'A')
    const result = init(f, 'asar:A.asar'); expect(result.status, result.stderr).toBe(0)
    expect(await f.json()).toMatchObject({...A, appVersion: '0.7.0'})
  })
  it('reads creator source and version from the ZIP itself', async () => {
    const f = await repository()
    await zip(f.root, 'creator.zip', [
      ['create-pet-character/build-source.json', Buffer.from(JSON.stringify(A))],
      ['create-pet-character/runtime/package.json', Buffer.from(JSON.stringify({name: 'daemonlet-character-runtime', version: '0.6.0'}))],
    ])
    const result = init(f, 'creatorZip:creator.zip'); expect(result.status, result.stderr).toBe(0)
    expect(await f.json()).toMatchObject({...A, appVersion: '0.6.0'})
  })
  it.each(['source', 'version'])('rejects multiple artifacts with mixed %s', async mixed => {
    const f = await repository(); await asar(f.root, 'A'); await asar(f.root, 'B', mixed === 'source' ? B : A, mixed === 'version' ? '0.8.0' : '0.7.0')
    const result = init(f, 'asar:A.asar', 'asar:B.asar'); expect(result.status).not.toBe(0)
    await expect(f.json()).rejects.toThrow()
  })
  it.each(['missing', 'malformed source', 'mismatched renderer', 'invalid version', 'invalid archive', 'empty ZIP', 'duplicate apps'])('rejects %s without checkout fallback', async mode => {
    const f = await repository()
    if (mode === 'invalid archive') await writeFile(join(f.root, 'outputs/A.asar'), 'not an ASAR')
    else await asar(f.root, 'A', mode === 'missing' ? null : mode === 'malformed source' ? {...A, sourceCommit: 'invalid'} : A, mode === 'invalid version' ? null : '0.7.0', mode === 'mismatched renderer' ? B : A)
    let artifact = 'asar:A.asar'
    if (['empty ZIP', 'duplicate apps'].includes(mode)) {
      const bytes = await readFile(join(f.root, 'outputs/A.asar'))
      await zip(f.root, 'A.zip', mode === 'empty ZIP' ? [['README.md', Buffer.from('no build information')]] : [['A/resources/app.asar', bytes], ['B/resources/app.asar', bytes]])
      artifact = 'windowsPortableZip:A.zip'
    }
    const result = init(f, artifact); expect(result.status).not.toBe(0)
    await expect(f.json()).rejects.toThrow()
  })
  it('uses only an EXE hash-bound packaging result, never old validation outcomes', async () => {
    const f = await repository(); const output = join(f.root, 'outputs')
    await writeFile(join(output, 'A.exe'), 'MZ synthetic installer A')
    const file = await fileIdentity(output, 'A.exe')
    const receipt = {schemaVersion: 1, kind: 'windows-installer-build', source: A, appVersion: '0.5.0', files: [file], runtimeUnchanged: true, checks: [{kind: 'nativeInstall', status: 'PASS'}]}
    await writeFile(join(output, 'installer-build-result.json'), JSON.stringify(receipt))
    const result = f.cli('init', '--record', 'outputs/validation.json', '--artifact', 'windowsInstallerExe:A.exe', '--packaging-result', 'outputs/installer-build-result.json')
    expect(result.status, result.stderr).toBe(0)
    const record = await f.json(); expect(record).toMatchObject({...A, appVersion: '0.5.0'})
    expect(record.checks.every((c: any) => c.status === 'NOT_RUN')).toBe(true)
    await rm(join(output, 'validation.json')); await writeFile(join(output, 'A.exe'), 'MZ synthetic installer B')
    expect(f.cli('init', '--record', 'outputs/validation.json', '--artifact', 'windowsInstallerExe:A.exe', '--packaging-result', 'outputs/installer-build-result.json').status).not.toBe(0)
    expect(init(f, 'windowsInstallerExe:A.exe').status).not.toBe(0)
  })
})

describe.each(['unit', 'build'])('%s execution rechecks its source', kind => {
  async function setup(dirty = false) {
    const f = await repository(), output = join(f.root, 'outputs')
    if (dirty) await writeFile(join(f.root, 'source.txt'), 'already dirty\n')
    const source = await sourceIdentity(f.root)
    await writeFile(join(output, 'app.zip'), 'frozen artifact'); await writeFile(join(output, 'previous.log'), 'previous completed execution\n')
    const record = await createValidation({root: output, source, appVersion: '0.7.0', artifacts: [{file: 'app.zip', kind: 'portableZip'}]})
    await recordCheck(record, output, {kind, status: 'PASS', procedure: 'prior synthetic check', evidence: ['previous.log']})
    await writeFile(join(output, 'validation.json'), JSON.stringify(record))
    return {...f, source, run: (code: string) => f.cli('run', '--record', 'outputs/validation.json', '--kind', kind, '--', process.execPath, '-e', code)}
  }
  it.each([false, true])('passes an unchanged source (initially dirty: %s)', async dirty => {
    const f = await setup(dirty)
    const result = f.run("console.log('completed')")
    expect(result.status, result.stderr).toBe(0)
    const record = await f.json(), check = record.checks.find((c: any) => c.kind === kind)
    expect(check.status).toBe('PASS')
    const log = await f.json('outputs/' + check.evidence[0].file)
    expect(log.sourceBefore).toEqual(f.source); expect(log.sourceAfter).toEqual(f.source)
  })
  it.each(['tracked', 'untracked', 'HEAD', 'dirty then changed'])('fails when execution changes %s, superseding prior PASS', async mode => {
    const f = await setup(mode === 'dirty then changed')
    const mutation = mode === 'HEAD' ? "require('node:child_process').execFileSync('git',['commit','--allow-empty','-qm','moved HEAD'])"
      : `require('node:fs').writeFileSync(${JSON.stringify(mode === 'untracked' ? 'new-file.txt' : 'source.txt')}, 'changed during execution')`
    const result = f.run(`console.log('command executed'); ${mutation}`)
    expect(result.status).not.toBe(0)
    const record = await f.json(), check = record.checks.find((c: any) => c.kind === kind)
    expect(check.status).toBe('FAIL'); expect(record.sourceCommit).toBe(f.source.sourceCommit)
    const log = await f.json('outputs/' + check.evidence[0].file)
    expect(log.code).toBe(0); expect(log.stdout).toContain('command executed')
    expect(log.previousCheck.status).toBe('PASS'); expect(log.sourceBefore).toEqual(f.source)
    expect(log.sourceAfter).not.toEqual(f.source); expect(log.sourceError).toContain('Source changed during execution:')
    if (mode === 'dirty then changed') expect(log.sourceAfter.workingTreeHasChanges).toBe(true)
    const required = f.cli('verify', '--record', 'outputs/validation.json', '--required', kind)
    expect(required.status).not.toBe(0); expect(required.stderr).toContain('Required check did not pass')
  })
  it('rejects a dirty-flag change even when HEAD and file contents stay identical', async () => {
    const f = await setup(true)
    expect(f.run("require('node:child_process').execFileSync('git',['update-index','--assume-unchanged','source.txt'])").status).not.toBe(0)
    const record = await f.json(), check = record.checks.find((c: any) => c.kind === kind)
    const log = await f.json('outputs/' + check.evidence[0].file)
    expect(log.sourceAfter.sourceCommit).toBe(f.source.sourceCommit)
    expect(log.sourceAfter.sourceTreeSha256).toBe(f.source.sourceTreeSha256)
    expect(log.sourceAfter.workingTreeHasChanges).toBe(false)
    expect(log.sourceError).toContain('workingTreeHasChanges')
    expect(check.status).toBe('FAIL')
    expect(f.cli('verify', '--record', 'outputs/validation.json', '--required', kind).status).not.toBe(0)
  })
  it('invalidates PASS before the child runs and also fails a preflight mismatch', async () => {
    const f = await setup()
    const result = f.run(`const r=JSON.parse(require('node:fs').readFileSync('outputs/validation.json')); if(r.checks.find(c=>c.kind===${JSON.stringify(kind)}).status==='PASS')process.exit(2)`)
    expect(result.status, result.stderr).toBe(0)
    await writeFile(join(f.root, 'source.txt'), 'changed before next execution')
    expect(f.run("throw Error('must not run')").status).not.toBe(0)
    const record = await f.json(), check = record.checks.find((c: any) => c.kind === kind)
    expect(check.status).toBe('FAIL')
    const log = await f.json('outputs/' + check.evidence[0].file)
    expect(log.executed).toBe(false); expect(log.sourceError).toContain('Build source mismatch')
    expect(f.cli('verify', '--record', 'outputs/validation.json', '--required', kind).status).not.toBe(0)
  })
})
