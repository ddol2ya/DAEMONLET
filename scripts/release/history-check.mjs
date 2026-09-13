// Read-only reachable-object review of this repository. Never prints blob content.
import {execFileSync} from 'node:child_process'
import {resolve} from 'node:path'
import {scanSourceText, sourcePathFindings} from './source-policy.mjs'
const root = resolve(import.meta.dirname, '../..')
const git = args => execFileSync('git', args, {cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 ** 2}).trim()
const refs = git(['for-each-ref', '--format=%(refname)']).split('\n').filter(Boolean)
const commits = git(['rev-list', '--all']).split('\n').filter(Boolean)
const findings = [], cache = new Map()
for (const commit of commits) {
  for (const row of git(['ls-tree', '-rlz', commit]).split('\0').filter(Boolean)) {
    const [meta, path] = row.split('\t'), [mode, type, oid, size] = meta.trim().split(/\s+/)
    if (type !== 'blob') continue
    const key = oid + ':' + path
    if (!cache.has(key)) {
      const result = sourcePathFindings(path)
      if (mode === '120000') result.push({path, line: 1, type: 'symlink'})
      if (+size > 50 * 1024 ** 2) result.push({path, line: 1, type: 'large-source-file'})
      else if (!/\.(png|psd|icns|ico|jpe?g|webp)$/i.test(path)) result.push(...scanSourceText(git(['cat-file', 'blob', oid]), path))
      cache.set(key, result)
    }
    for (const finding of cache.get(key)) findings.push({commit, ...finding})
  }
}
const affected = [...new Set(findings.map(f => f.commit))]
const containingRefs = Object.fromEntries(affected.map(c => [c, git(['for-each-ref', '--contains', c, '--format=%(refname)']).split('\n').filter(Boolean)]))
console.log(JSON.stringify({status: findings.length ? 'PUBLICATION_BLOCKER_HISTORY_REVIEW' : 'reviewed-no-pattern-findings', shallow: git(['rev-parse', '--is-shallow-repository']) === 'true', refs, commits: commits.length, findings, containingRefs, limitations: 'Reachable local refs only; compare remote inventory separately. Not an exhaustive credential or authorship audit. Reflogs, inaccessible refs, old PR diffs and existing clones need separate review.'}, null, 2))
if (findings.length) process.exitCode = 1
