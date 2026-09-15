import { readFile, readdir, realpath, rm, stat } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'

// Resolve the actual manifest graph before deleting anything from build output.
// Source images referenced by Motion Lab remain runtime assets.
export async function runtimeAssetPaths(directory) {
  const root = await realpath(directory)
  const files = new Set(['catalog.json'])
  const json = async path => JSON.parse(await readFile(resolve(root, path), 'utf8'))
  async function add(ref, from) {
    if (typeof ref !== 'string' || !ref || /[\\:%?#]/.test(ref) || ref.startsWith('/')) throw new Error(`Invalid asset reference in ${from}`)
    const path = resolve(root, dirname(from), ref)
    const actual = await realpath(path)
    const rel = relative(root, actual)
    if (rel === '..' || rel.startsWith(`..${sep}`) || !(await stat(actual)).isFile()) throw new Error(`Asset escapes character root: ${from}`)
    const name = relative(root, path).split(sep).join('/')
    files.add(name)
    return name
  }
  for (const ref of (await json('catalog.json')).characters) {
    const path = await add(ref, 'catalog.json'), character = await json(path)
    // Only the approved Gpichan notice, not arbitrary files in character folders.
    if (path === 'gpichan/character.json') await add('LICENSE.txt', path)
    for (const key of ['source', 'psd', 'overrides']) if (character.base[key]) await add(character.base[key], path)
    for (const key of ['behavior', 'dialogue', 'thumbnail', 'persona']) if (character[key]) await add(character[key], path)
    for (const ref of character.poses) {
      const posePath = await add(ref, path), pose = await json(posePath)
      for (const key of ['source', 'psd', 'overrides']) if (pose[key]) await add(pose[key], posePath)
    }
  }
  return [...files].sort()
}

export async function pruneRuntimeAssets(directory) {
  const keep = new Set(await runtimeAssetPaths(directory))
  async function walk(path, prefix = '') {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const name = prefix + entry.name, child = resolve(path, entry.name)
      if (entry.isDirectory()) {
        await walk(child, name + '/')
        if (!(await readdir(child)).length) await rm(child, { recursive: true })
      } else if (!keep.has(name)) await rm(child)
    }
  }
  await walk(directory)
  return [...keep].sort()
}
