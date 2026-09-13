// File-external candidate evidence; creating a record never completes a check.
import {execFileSync} from 'node:child_process'
import {createHash, randomUUID} from 'node:crypto'
import {createReadStream} from 'node:fs'
import {lstat, readFile, readlink, realpath, writeFile} from 'node:fs/promises'
import {isAbsolute, join, relative, resolve, sep} from 'node:path'
import {arch, platform, release, version} from 'node:os'

export const checkKinds = ['unit', 'build', 'asar', 'creatorExtraction', 'nativePackageSmoke', 'nativeInstall', 'realCodexIntegration', 'signing', 'notarization']
const sha = value => createHash('sha256').update(value).digest('hex')
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
export const environment = () => ({platform: platform(), arch: arch(), osVersion: `${release()} (${version()})`, nodeVersion: process.version, codexVersion: 'NOT_RUN: real Codex integration not exercised'})
export const timestamp = () => ({checkedAt: new Date().toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone})
export async function sourceIdentity(root) {
  const git = args => execFileSync('git', args, {cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 ** 2}).trimEnd()
  const files = [...new Set(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean))].sort()
  const contents = []
  for (const file of files) {
    try {
      const path = join(root, file), info = await lstat(path)
      contents.push([file, info.mode & 0o777, info.isSymbolicLink() ? sha(await readlink(path)) : sha(await readFile(path))])
    } catch (error) { if (error.code !== 'ENOENT') throw error; contents.push([file, 'deleted']) }
  }
  return {sourceCommit: git(['rev-parse', 'HEAD']), workingTreeHasChanges: Boolean(git(['status', '--porcelain=v1', '--untracked-files=all'])), sourceTreeSha256: sha(JSON.stringify(contents))}
}
export function assertSameSource(expected, actual) {
  for (const field of ['sourceCommit', 'sourceTreeSha256', 'workingTreeHasChanges']) {
    if (expected[field] !== actual[field]) throw Error(`Build source mismatch: ${field}. Rebuild both renderer and Electron from one source snapshot.`)
  }
}
export async function fileIdentity(root, file) {
  if (typeof file !== 'string' || !file || isAbsolute(file) || file.includes('\\') || file.split('/').some(p => !p || p === '.' || p === '..')) throw Error('Evidence/artifact path must be a relative file name')
  const base = await realpath(root), path = resolve(base, file), canonical = await realpath(path)
  if (!canonical.startsWith(base + sep) || !(await lstat(path)).isFile()) throw Error('Evidence/artifact must be an ordinary file inside its record directory')
  const hash = createHash('sha256'); let bytes = 0
  for await (const part of createReadStream(path)) { hash.update(part); bytes += part.length }
  return {file, bytes, sha256: hash.digest('hex')}
}
export function buildIdentity(source, appVersion) {
  if (!/^[a-f0-9]{40}$/.test(source?.sourceCommit ?? '') || !/^[a-f0-9]{64}$/.test(source?.sourceTreeSha256 ?? '') || typeof source?.workingTreeHasChanges !== 'boolean') throw Error('A valid captured build source identity is required')
  if (typeof appVersion !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(appVersion)) throw Error('A valid artifact app version is required')
  return {source: {sourceCommit: source.sourceCommit, sourceTreeSha256: source.sourceTreeSha256, workingTreeHasChanges: source.workingTreeHasChanges}, appVersion}
}
export async function createValidation({root, source, appVersion, artifacts, target = environment()}) {
  source = buildIdentity(source, appVersion).source
  const inventory = []
  for (const {file, kind} of artifacts) {
    if (!kind || inventory.some(a => a.file === file)) throw Error('Invalid/duplicate artifact')
    inventory.push({...await fileIdentity(root, file), kind})
  }
  if (!inventory.length) throw Error('At least one final artifact is required')
  return {schemaVersion: 1, candidateId: randomUUID(), ...source, appVersion, ...timestamp(), target,
    artifacts: inventory, checks: checkKinds.map(kind => ({kind, status: 'NOT_RUN', reason: 'No execution recorded for this candidate'})),
    decisions: {technicalReadiness: 'NOT_RUN', characterRights: 'BLOCKED: underlying community reference terms unverified', externalModelTerms: 'BLOCKED: separate external license review pending', gitHistory: 'NOT_RUN', publication: 'NOT_RUN: human decision required; no publication authorized'}}
}
/** @param {any} record @param {string} root @param {{required?: string[], source?: any}} [options] */
export async function verifyValidation(record, root, {required = [], source} = {}) {
  if (record.schemaVersion !== 1 || !record.candidateId || !record.appVersion || !record.checkedAt || !record.timeZone || !record.target?.osVersion || !record.target?.platform || !record.target?.arch) throw Error('Incomplete candidate metadata')
  if (!/^[a-f0-9]{40}$/.test(record.sourceCommit) || !/^[a-f0-9]{64}$/.test(record.sourceTreeSha256) || typeof record.workingTreeHasChanges !== 'boolean') throw Error('Invalid build source identity')
  if (source) assertSameSource(record, source)
  if (!record.artifacts?.length || new Set(record.artifacts.map(a => a.file)).size !== record.artifacts.length) throw Error('Missing/duplicate artifacts')
  for (const artifact of record.artifacts) {
    const actual = await fileIdentity(root, artifact.file)
    if (!artifact.kind || actual.bytes !== artifact.bytes || actual.sha256 !== artifact.sha256) throw Error('Artifact hash mismatch: ' + artifact.file)
  }
  if (!Array.isArray(record.checks) || record.checks.length !== checkKinds.length || new Set(record.checks.map(c => c.kind)).size !== checkKinds.length) throw Error('Missing/duplicate checks')
  for (const check of record.checks) {
    if (!checkKinds.includes(check.kind) || !['PASS', 'FAIL', 'NOT_RUN', 'BLOCKED', 'N/A'].includes(check.status)) throw Error('Unknown check kind/status')
    if (['PASS', 'FAIL'].includes(check.status)) {
      if (check.candidateId !== record.candidateId || check.sourceCommit !== record.sourceCommit || check.sourceTreeSha256 !== record.sourceTreeSha256 || !same(check.artifacts, record.artifacts)) throw Error('Check belongs to a different candidate/source/artifact')
      if (!check.procedure || !check.checkedAt || !check.timeZone || !check.environment?.platform || !check.environment?.arch || !check.environment?.osVersion || !check.environment?.codexVersion || !check.evidence?.length) throw Error('Executed check lacks procedure, environment or evidence')
      for (const evidence of check.evidence) {
        const actual = await fileIdentity(root, evidence.file)
        if (!actual.bytes || !same(actual, evidence)) throw Error('Missing or altered check evidence: ' + evidence.file)
      }
    } else if (!check.reason?.trim()) throw Error('Unexecuted/N/A check needs a reason')
  }
  for (const kind of required) {
    if (!checkKinds.includes(kind) || record.checks.find(c => c.kind === kind)?.status !== 'PASS') throw Error('Required check did not pass: ' + kind)
  }
  return {status: 'record-integrity-verified', candidateId: record.candidateId, completed: record.checks.filter(c => c.status === 'PASS').map(c => c.kind)}
}
export async function recordCheck(record, root, {kind, status, procedure, evidence, executionEnvironment = environment()}) {
  await verifyValidation(record, root)
  if (!checkKinds.includes(kind) || !['PASS', 'FAIL'].includes(status)) throw Error('An executed check kind and outcome are required')
  const entry = {kind, status, candidateId: record.candidateId, sourceCommit: record.sourceCommit, sourceTreeSha256: record.sourceTreeSha256,
    artifacts: structuredClone(record.artifacts), ...timestamp(), environment: executionEnvironment, procedure,
    evidence: await Promise.all(evidence.map(file => fileIdentity(root, file)))}
  const updated = {...record, checks: record.checks.map(c => c.kind === kind ? entry : c)}
  await verifyValidation(updated, root)
  Object.assign(record, updated)
}
export async function saveValidation(root, record, name = 'validation.json') {
  await verifyValidation(record, root)
  await writeFile(join(root, name), JSON.stringify(record, null, 2) + '\n', {mode: 0o600})
}
export async function readBuildSource(root) {
  const renderer = JSON.parse(await readFile(join(root, 'dist/build-source.json'), 'utf8'))
  const desktop = JSON.parse(await readFile(join(root, 'dist-electron/build-source.json'), 'utf8'))
  assertSameSource(renderer, desktop)
  return desktop
}
