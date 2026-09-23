import { compileChatAuthoring } from './chat-authoring.mjs'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { constants } from 'node:fs'
import { createWriteStream } from 'node:fs'
import { access, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pipeline } from 'node:stream/promises'
import { ZipFile } from 'yazl'
import { withPackTools } from './pack-tools.mjs'

export async function exportPack(values, preserved = {}) {
if (!values['character-root'] || !values.output || !values.version) throw new Error('Usage: node scripts/characters/export-pack.mjs --character-root <payload> --version X.Y.Z --output <file.petchar> [--author <name>] [--profile trial|full]')
const root = resolve(values['character-root']), output = resolve(values.output)
if (await access(output).then(() => true, () => false)) throw new Error('Output already exists. Use a new version/output path; overwriting is not implicit.')
if (!relative(root, output).startsWith('..')) throw new Error('The archive must be outside the payload directory')
const stage = await mkdtemp(join(tmpdir(), 'petchar-export-'))
try {
  return await withPackTools(async tools => {
    const files = []
    const walk = async (directory, prefix = '') => {
      for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
        const path = tools.validatePackPath(prefix + entry.name), source = join(directory, entry.name)
        if (entry.isSymbolicLink() || (await lstat(source)).nlink > 1 && !entry.isDirectory()) throw new Error('PACK_PATH')
        if (entry.isDirectory()) await walk(source, `${path}/`)
        else {
          if (!entry.isFile() || !tools.isPayloadPath(path) || path === 'pack.json') throw new Error(`Unexpected payload file: ${path}`)
          const bytes = await tools.boundedFile(root, path)
          files.push({ path, bytes: bytes.length, sha256: tools.sha256(bytes) })
          await mkdir(dirname(join(stage, path)), { recursive: true })
          await writeFile(join(stage, path), bytes)
        }
      }
    }
    await walk(root)
    const character = JSON.parse(await readFile(join(stage, 'character.json'), 'utf8'))
    if (character.chat || values['chat-plan'] || !preserved.packFormatVersion) {
      const poses = await Promise.all(character.poses.map(async ref => JSON.parse(await tools.boundedFile(stage, tools.resolvePackReference(ref, 'character.json', new Set(files.map(f => f.path)))))))
      const poseIds = poses.map(p => p.id)
      const existing = character.chat ? JSON.parse(await tools.boundedFile(stage, tools.resolvePackReference(character.chat, 'character.json', new Set(files.map(f => f.path))), tools.CHAT_LIMITS.bytes)) : undefined
      const plan = values['chat-plan'] ? JSON.parse(await readFile(resolve(values['chat-plan']), 'utf8')) : {}
      const compiled = compileChatAuthoring(tools, plan, poseIds, existing)
      const chatPath = character.chat ? tools.resolvePackReference(character.chat, 'character.json') : 'chat.json'
      character.chat = chatPath
      for (const [file, value] of [[chatPath, compiled.chat], ['character.json', character]]) {
        const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n')
        await writeFile(join(stage, file), bytes)
        const record = { path: file, bytes: bytes.length, sha256: tools.sha256(bytes) }
        const index = files.findIndex(f => f.path === file); if (index < 0) files.push(record); else files[index] = record
      }
      if (values['chat-report']) await writeFile(resolve(values['chat-report']), JSON.stringify(compiled.report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    }
    const behavior = character.behavior ? tools.parseBehaviorManifest(JSON.parse(await tools.boundedFile(stage,
      tools.resolvePackReference(character.behavior, 'character.json', new Set(files.map(f => f.path)))))).value : undefined
    const needsVariants = character.poses.length > tools.PACK_LIMITS.poses || behavior && tools.behaviorUsesPoseVariants(behavior)
    const dialogue = character.dialogue ? tools.parseDialogueManifest(JSON.parse(await tools.boundedFile(stage,
      tools.resolvePackReference(character.dialogue, 'character.json', new Set(files.map(f => f.path)))))) : undefined
    const update = values['repo-id'] || values['manifest-path'] ? tools.parseUpdateSource({ schemaVersion: 1, provider: 'huggingface', repoType: 'dataset', repoId: values['repo-id'], manifestPath: values['manifest-path'] }) : preserved.update
    const runtime = preserved.runtime
      ? { ...preserved.runtime, capabilities: [...new Set([...preserved.runtime.capabilities, ...(character.persona ? ['side-chat-persona-v1'] : []), ...(character.chat ? ['character-chat-v1'] : []), ...(update ? ['hf-pack-updates-v1'] : [])])] }
      : { ...tools.PACK_RUNTIME, capabilities: tools.PACK_RUNTIME.capabilities.filter(c =>
        (c !== 'character-chat-v1' || Boolean(character.chat)) && (c !== 'hf-pack-updates-v1' || Boolean(update)) && (c !== 'side-chat-persona-v1' || Boolean(character.persona)) && (c !== 'pose-variants' || needsVariants) && (c !== 'pose-dialogue' || dialogue?.poseLines)) }
    let provenance = {}
    try { provenance = JSON.parse(await readFile(join(stage, 'provenance.json'), 'utf8')) } catch { /* Optional. */ }
    const manifest = { ...preserved, packFormatVersion: 1, id: character.id, name: character.label, version: values.version, entry: 'character.json', runtime, files, ...(update ? { update } : {}),
      ...(values.author ? { author: values.author } : {}), ...(values.thumbnail ? { thumbnail: values.thumbnail } : {}),
      ...(values.profile || preserved.profile || provenance.profile ? { profile: values.profile ?? preserved.profile ?? provenance.profile } : {}), ...(preserved.unsupportedReactions || provenance.unsupportedReactions ? { unsupportedReactions: preserved.unsupportedReactions ?? provenance.unsupportedReactions } : {}),
    }
    await writeFile(join(stage, 'pack.json'), JSON.stringify(manifest, null, 2) + '\n')
    const validation = await tools.validatePackDirectory(stage)
    await mkdir(dirname(output), { recursive: true })
    const temporary = `${output}.tmp-${process.pid}`, zip = new ZipFile()
    for (const path of ['pack.json', ...files.map(f => f.path)].sort()) zip.addFile(join(stage, path), path, { mtime: new Date('2000-01-01T00:00:00Z'), mode: 0o100644, compress: true })
    zip.end()
    try { await pipeline(zip.outputStream, createWriteStream(temporary, { flags: 'wx', mode: 0o600 })); if ((await lstat(temporary)).size > tools.PACK_LIMITS.archiveBytes) throw new Error('PACK_LIMIT'); await copyFile(temporary, output, constants.COPYFILE_EXCL) }
    finally { await rm(temporary, { force: true }) }
    return { id: character.id, version: values.version, revision: validation.revision, bytes: validation.bytes, poseCount: validation.poseCount, output }
  })
} finally { await rm(stage, { recursive: true, force: true }) }

}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
const { values } = parseArgs({ options: { 'chat-plan': { type: 'string' }, 'chat-report': { type: 'string' }, 'character-root': { type: 'string' }, version: { type: 'string' }, output: { type: 'string' }, author: { type: 'string' }, thumbnail: { type: 'string' }, profile: { type: 'string' }, 'repo-id': { type: 'string' }, 'manifest-path': { type: 'string' } } })
console.log(JSON.stringify(await exportPack(values), null, 2))
}
