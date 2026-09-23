// Shared by the application, staging, Forge and installer verification.
import catalog from './runtime-catalog.json' with { type: 'json' }
import {createReadStream} from 'node:fs'
import {lstat, readFile, readdir} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {join, resolve} from 'node:path'
import {isDeepStrictEqual} from 'node:util'

export function runtimeTarget(platform = process.platform, arch = process.arch) { return `${platform}-${arch}` }
/** @typedef {{platform:string,commit:string,executable:string,launcher?:string,backend:string,files:Record<string,{bytes:number,sha256:string}>,build:object}} RuntimeEntry */
/** @returns {RuntimeEntry} */
export function selectRuntime(target = runtimeTarget(), trusted = catalog) {
  const entry = trusted.targets[target]
  if (!entry || entry.platform !== target) throw Error(`No validated character-chat runtime for ${target}`)
  // llama passes FILE/CRT-owned objects across its internal libraries. Separate
  // static CRT instances in shared DLLs fail at model IO on Windows.
  if (target === 'win32-x64' && entry.build?.sharedLibraries && entry.build?.msvcRuntime === 'MultiThreaded') throw Error('Unsupported shared-library/static-CRT runtime combination')
  return entry
}
/** @param {string} root @param {string} target @param {{signal?: AbortSignal, trusted?: typeof catalog}} options */
export async function verifyRuntime(root, target = runtimeTarget(), {signal, trusted = catalog} = {}) {
  const entry = selectRuntime(target, trusted)
  signal?.throwIfAborted()
  const lock = JSON.parse(await readFile(join(root, 'runtime-lock.json'), 'utf8').catch(() => { throw Error('Stage the pinned character-chat runtime and rebuild before packaging') }))
  if (!isDeepStrictEqual(entry, lock)) throw Error('Character-chat runtime catalog differs')
  if (!(await lstat(root)).isDirectory() || (await lstat(root)).isSymbolicLink()) throw Error('Runtime directory must be ordinary')
  const found = []
  async function walk(directory, prefix = '') {
    for (const item of await readdir(directory, {withFileTypes:true})) {
      signal?.throwIfAborted()
      const name = prefix + item.name
      if (item.isDirectory()) await walk(join(directory,item.name), name + '/')
      else if (item.isFile()) found.push(name)
      else throw Error('Runtime contains a link or non-ordinary file')
    }
  }
  await walk(root)
  if (!isDeepStrictEqual(found.sort(), ['runtime-lock.json', ...Object.keys(entry.files)].sort())) throw Error('Runtime file allowlist differs')
  for (const [name, metadata] of Object.entries(entry.files)) {
    signal?.throwIfAborted()
    if (!/^(?:licenses\/)?[\w.\-]+$/.test(name) || !Number.isSafeInteger(metadata.bytes) || metadata.bytes <= 0 || !/^[a-f0-9]{64}$/.test(metadata.sha256)) throw Error('Invalid trusted runtime catalog')
    const path = resolve(root,name), info = await lstat(path)
    if (!info.isFile() || info.size !== metadata.bytes) throw Error(`Runtime size differs: ${name}`)
    const hash = createHash('sha256')
    let header = Buffer.alloc(0)
    for await (const part of createReadStream(path, {signal})) {
      hash.update(part)
      if (header.length < 4096) header = Buffer.concat([header,part.subarray(0,4096-header.length)])
    }
    if (hash.digest('hex') !== metadata.sha256) throw Error(`Runtime hash differs: ${name}`)
    if (target === 'win32-x64' && /\.(exe|dll)$/i.test(name)) {
      const offset = header.length >= 64 ? header.readUInt32LE(60) : -1
      if (header.toString('ascii',0,2) !== 'MZ' || offset < 64 || offset + 6 > header.length || header.readUInt32LE(offset) !== 0x4550 || header.readUInt16LE(offset+4) !== 0x8664) throw Error(`Runtime is not Windows AMD64 PE: ${name}`)
    }
  }
  signal?.throwIfAborted()
  return entry
}
