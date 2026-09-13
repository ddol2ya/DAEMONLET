import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {dirname, join, resolve} from 'node:path'
import {parseArgs} from 'node:util'
import {spawn} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {checkKinds, recordCheck, saveValidation, verifyValidation, sourceIdentity, assertSameSource, environment} from './validation.mjs'
import {initializeValidation} from './artifact-source.mjs'
const [action, ...args] = process.argv.slice(2)
const {values, positionals} = parseArgs({args, allowPositionals: true, options: {
  record: {type: 'string'}, artifact: {type: 'string', multiple: true}, 'packaging-result': {type: 'string', multiple: true}, kind: {type: 'string'}, required: {type: 'string', multiple: true}, platform: {type: 'string'}, arch: {type: 'string'}, 'target-os': {type: 'string'},
}})
if (!values.record) throw Error('Require --record <outputs/candidate/validation.json>; init --artifact <kind:relative-file> [--packaging-result installer-build-result.json], verify [--required kind], or run --kind <kind> -- <executable> [args]')
const path = resolve(values.record), root = dirname(path), checkout = resolve(import.meta.dirname, '../..')
if (action === 'init') {
  const artifacts = (values.artifact ?? []).map(value => { const colon = value.indexOf(':'); if (colon < 1) throw Error('Use kind:relative-file'); return {kind: value.slice(0, colon), file: value.slice(colon + 1)} })
  const target = {...environment(), ...(values.platform ? {platform: values.platform} : {}), ...(values.arch ? {arch: values.arch} : {}), ...(values['target-os'] ? {osVersion: values['target-os']} : {})}
  if (target.platform !== process.platform && !values['target-os']) throw Error('Cross-platform target needs --target-os; use NOT_RUN if native OS is unavailable')
  const record = await initializeValidation({root, artifacts, packagingResults: values['packaging-result'], target})
  await writeFile(path, JSON.stringify(record, null, 2) + '\n', {flag: 'wx', mode: 0o600})
  console.log(JSON.stringify({candidateId: record.candidateId, checks: 'NOT_RUN', record: values.record}))
} else {
  const record = JSON.parse(await readFile(path, 'utf8'))
  await verifyValidation(record, root)
  if (action === 'run') {
    if (!checkKinds.includes(values.kind) || !positionals.length) throw Error('Require a known --kind and an actual command after --')
    const log = `evidence/${values.kind}-${randomUUID()}.json`
    await mkdir(join(root, 'evidence'), {recursive: true, mode: 0o700})
    const previousCheck = record.checks.find(c => c.kind === values.kind)
    // Persist invalidation before the command, including interrupted/failed attempts.
    // Retain the previous outcome in this attempt's log, not as the current PASS.
    await writeFile(join(root, log), JSON.stringify({command: positionals, previousCheck, phase: 'starting'}) + '\n', {mode: 0o600})
    record.checks = record.checks.map(c => c.kind === values.kind ? {kind: c.kind, status: 'NOT_RUN', reason: 'New execution supersedes the previous outcome; pending attempt: ' + log} : c)
    await saveValidation(root, record, path.slice(root.length + 1))
    let sourceBefore, sourceAfter, sourceError, executed = false
    let result = {code: null, stdout: '', stderr: '', stopped: false}
    try {
      if (['unit', 'build'].includes(values.kind)) {
        sourceBefore = await sourceIdentity(checkout)
        assertSameSource(record, sourceBefore)
      }
      executed = true
      result = await new Promise(done => {
        const child = spawn(positionals[0], positionals.slice(1), {cwd: checkout, env: process.env, shell: false, stdio: ['ignore', 'pipe', 'pipe']})
        let stdout = '', stderr = '', bytes = 0, stopped = false
        const timer = setTimeout(() => { stopped = true; child.kill('SIGTERM') }, 15 * 60 * 1000)
        for (const [stream, channel] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) stream.on('data', part => {
          bytes += part.length
          if (bytes > 16 * 1024 ** 2) { stopped = true; child.kill('SIGTERM'); return }
          if (channel === 'stdout') stdout += part; else stderr += part
        })
        child.once('error', error => { clearTimeout(timer); done({code: null, error: error.message, stdout, stderr, stopped}) })
        child.once('close', (code, signal) => { clearTimeout(timer); done({code, signal, stopped, stdout, stderr}) })
      })
      if (sourceBefore) {
        sourceAfter = await sourceIdentity(checkout)
        const fields = ['sourceCommit', 'sourceTreeSha256', 'workingTreeHasChanges']
        const changed = fields.filter(field => sourceAfter[field] !== sourceBefore[field] || sourceAfter[field] !== record[field])
        if (changed.length) throw Error('Source changed during execution: ' + changed.join(', '))
      }
    } catch (error) { sourceError = error.message }
    await writeFile(join(root, log), JSON.stringify({command: positionals, previousCheck, executed, ...result, sourceBefore, sourceAfter, sourceError}, null, 2) + '\n', {mode: 0o600})
    const passed = result.code === 0 && !result.stopped && !sourceError
    // Artifact changes also fail; the persisted pending state cannot retain an old PASS.
    await recordCheck(record, root, {kind: values.kind, status: passed ? 'PASS' : 'FAIL', procedure: positionals, evidence: [log]})
    await saveValidation(root, record, path.slice(root.length + 1))
    if (!passed) process.exitCode = 1
  } else if (action !== 'verify') throw Error('Unknown validation action')
  console.log(JSON.stringify(await verifyValidation(record, root, {required: values.required ?? []})))
}
