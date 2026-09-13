// Read-only preflight. Installing the lockfile-pinned runtime is always explicit.
import {readFile, stat} from 'node:fs/promises'
import {resolve, sep} from 'node:path'

export async function requireElectronRuntime(root) {
  const base = resolve(root, 'node_modules/electron'), dist = resolve(base, 'dist')
  const missing = []
  try {
    const executable = (await readFile(resolve(base, 'path.txt'), 'utf8')).trim()
    const path = resolve(dist, executable)
    if (!executable || !path.startsWith(dist + sep) || !(await stat(path)).isFile()) throw Error()
    const pkg = JSON.parse(await readFile(resolve(base, 'package.json'), 'utf8'))
    if ((await readFile(resolve(dist, 'version'), 'utf8')).trim().replace(/^v/, '') !== pkg.version) throw Error()
  } catch { missing.push('Electron runtime (path.txt, executable or matching version)') }
  for (const name of ['LICENSE', 'LICENSES.chromium.html']) {
    try { if (!(await readFile(resolve(dist, name))).length) throw Error() }
    catch { missing.push(`electron/dist/${name}`) }
  }
  if (missing.length) throw Error(`Electron preparation incomplete: ${missing.join(', ')}. Run npm ci, then npm run electron:install. If notices are missing from an already installed runtime, remove only node_modules/electron/dist/version and rerun npm run electron:install to restore the pinned distribution. No download was attempted by this check.`)
}
