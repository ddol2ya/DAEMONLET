import {spawnSync} from 'node:child_process'
import {writeFile} from 'node:fs/promises'
import {join, resolve} from 'node:path'
import {sourceIdentity, assertSameSource} from './release/validation.mjs'
const root = resolve(import.meta.dirname, '..'), source = await sourceIdentity(root)
for (const args of [['node_modules/typescript/bin/tsc', '--noEmit'], ['node_modules/vite/bin/vite.js', 'build']]) {
  const result = spawnSync(process.execPath, args, {cwd: root, stdio: 'inherit'})
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
assertSameSource(source, await sourceIdentity(root))
await writeFile(join(root, 'dist/build-source.json'), JSON.stringify(source) + '\n')
