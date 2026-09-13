import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {dirname, join, resolve} from 'node:path'
import {parseArgs} from 'node:util'
import {spawn} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {createValidation, readBuildSource, recordCheck, saveValidation, verifyValidation, sourceIdentity, assertSameSource, environment} from './validation.mjs'
const [action, ...args] = process.argv.slice(2)
const {values, positionals} = parseArgs({args, allowPositionals: true, options: {
  record: {type: 'string'}, artifact: {type: 'string', multiple: true}, kind: {type: 'string'}, required: {type: 'string', multiple: true}, platform: {type: 'string'}, arch: {type: 'string'}, 'target-os': {type: 'string'},
}})
if (!values.record) throw Error('Require --record <outputs/candidate/validation.json>; init --artifact <kind:relative-file>, verify [--required kind], or run --kind <kind> -- <executable> [args]')
const path = resolve(values.record), root = dirname(path), checkout = resolve(import.meta.dirname, '../..')
if (action === 'init') {
  const source = await readBuildSource(checkout)
  const pkg = JSON.parse(await readFile(join(checkout, 'package.json'), 'utf8'))
  const artifacts = (values.artifact ?? []).map(value => { const colon = value.indexOf(':'); if (colon < 1) throw Error('Use kind:relative-file'); return {kind: value.slice(0, colon), file: value.slice(colon + 1)} })
  const target = {...environment(), ...(values.platform ? {platform: values.platform} : {}), ...(values.arch ? {arch: values.arch} : {}), ...(values['target-os'] ? {osVersion: values['target-os']} : {})}
  if (target.platform !== process.platform && !values['target-os']) throw Error('Cross-platform target needs --target-os; use NOT_RUN if native OS is unavailable')
  const record = await createValidation({root, source, appVersion: pkg.version, artifacts, target})
  await writeFile(path, JSON.stringify(record, null, 2) + '\n', {flag: 'wx', mode: 0o600})
  console.log(JSON.stringify({candidateId: record.candidateId, checks: 'NOT_RUN', record: values.record}))
} else {
  const record = JSON.parse(await readFile(path, 'utf8'))
  await verifyValidation(record, root)
  if (action === 'run') {
    if (!values.kind || !positionals.length) throw Error('Require --kind and an actual command after --')
    if (['unit', 'build'].includes(values.kind)) assertSameSource(record, await sourceIdentity(checkout))
    const log = `evidence/${values.kind}-${randomUUID()}.json`
    await mkdir(join(root, 'evidence'), {recursive: true, mode: 0o700})
    const result = await new Promise(done => {
      const child = spawn(positionals[0], positionals.slice(1), {cwd: checkout, env: process.env, shell: false, stdio: ['ignore', 'pipe', 'pipe']})
      let stdout = '', stderr = '', bytes = 0, stopped = false
      const timer = setTimeout(() => { stopped = true; child.kill('SIGTERM') }, 15 * 60 * 1000)
      for (const [stream, channel] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) stream.on('data', part => {
        bytes += part.length
        if (bytes > 16 * 1024 ** 2) { stopped = true; child.kill('SIGTERM'); return }
        if (channel === 'stdout') stdout += part; else stderr += part
      })
      child.once('error', error => { clearTimeout(timer); done({code: null, error: error.message, stdout, stderr}) })
      child.once('close', (code, signal) => { clearTimeout(timer); done({code, signal, stopped, stdout, stderr}) })
    })
    await writeFile(join(root, log), JSON.stringify({command: positionals, ...result}, null, 2) + '\n', {mode: 0o600})
    // Refuse to bless checks against files modified during execution.
    await recordCheck(record, root, {kind: values.kind, status: result.code === 0 && !result.stopped ? 'PASS' : 'FAIL', procedure: positionals, evidence: [log]})
    await saveValidation(root, record, path.slice(root.length + 1))
    if (result.code !== 0 || result.stopped) process.exitCode = 1
  } else if (action !== 'verify') throw Error('Unknown validation action')
  console.log(JSON.stringify(await verifyValidation(record, root, {required: values.required ?? []})))
}
