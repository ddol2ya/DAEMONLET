import { parseArgs } from 'node:util'
import { createHash } from 'node:crypto'
import { access, copyFile, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

const { values } = parseArgs({ options: Object.fromEntries(['source', 'id', 'label', 'profile', 'behavior', 'dialogue', 'output', 'runtime-patches'].map(k => [k, { type: 'string' }])) })
if (!values.source || !values.output || !values.behavior || !values.dialogue || !values.label?.trim() || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(values.id ?? '') || values.id.length > 64 || !['trial', 'full'].includes(values.profile)) throw new Error('Usage: node scripts/characters/build-independent-payload.mjs --source <selected-run> --id <id> --label <name> --profile trial|full --behavior <json> --dialogue <json> --output <payload> [--runtime-patches <pose-to-file-map.json>]')
const source = await realpath(resolve(values.source)), destination = resolve(values.output)
if (await access(destination).then(() => true, () => false)) throw new Error('Output exists. Choose a new output directory; no files were replaced.')
if (destination === source || destination.startsWith(source + sep)) throw new Error('Preserve the selected source run; output must be outside it')
const json = async p => JSON.parse(await readFile(p, 'utf8'))
const hash = async p => createHash('sha256').update(await readFile(p)).digest('hex')
const writeJson = (p, v) => writeFile(p, JSON.stringify(v, null, 2) + '\n')
const contained = async p => { const actual = await realpath(p), rel = relative(source, actual); if (rel === '..' || rel.startsWith(`..${sep}`) || actual === source) throw new Error('Source reference escapes selected run'); return actual }
const index = await json(join(source, 'models.json'))
if (index.strategy !== 'whole-model-per-pose' || !Array.isArray(index.models)) throw new Error('Expected a selected whole-model-per-pose models.json')
const required = values.profile === 'trial' ? ['waiting', 'writing', 'head-tap'] : ['waiting', 'writing', 'head-tap', 'failed', 'cancelled', 'disconnected', 'bored', 'happy', 'torso-tap', 'head-pet']
const ids = index.models.map(m => m.id)
if (ids.length !== new Set(ids).size || required.some(id => !ids.includes(id)) || ids.some(id => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))) throw new Error('The profile is missing distinct required poses')
const selected = values.profile === 'trial' ? index.models.filter(m => required.includes(m.id)) : index.models
const patches = values['runtime-patches'] ? await json(resolve(values['runtime-patches'])) : {}
const stage = `${destination}.building-${process.pid}`
await mkdir(dirname(destination), { recursive: true })
await mkdir(stage)
try {
  const records = []
  for (const model of selected) {
    const configPath = await contained(resolve(source, model.model)), config = await json(configPath), directory = dirname(configPath)
    const input = {}
    for (const [k, ref] of Object.entries({ psd: config.psd, source: config.bodySource, overrides: config.overrides, pose: config.pose })) input[k] = await contained(resolve(directory, ref))
    const output = join(stage, 'poses', model.id); await mkdir(output, { recursive: true })
    await copyFile(input.psd, join(output, 'model.psd')); await copyFile(input.source, join(output, 'source.png'))
    const overrides = await json(input.overrides)
    if (config.excludeAfterMeshResolution) overrides.excludeAfterMeshResolution = config.excludeAfterMeshResolution
    if (patches[model.id]) Object.assign(overrides, await json(resolve(dirname(resolve(values['runtime-patches'])), patches[model.id])))
    await writeJson(join(output, 'rig-overrides.json'), overrides)
    const pose = { ...await json(input.pose), id: model.id, label: model.label, source: 'source.png', psd: 'model.psd', overrides: 'rig-overrides.json', strategy: 'independent-model', registration: { strategy: 'identity', maxScaleDelta: 0, maxRotationDeg: 0, maxAnchorErrorPx: 0 }, layers: { sharedFromBase: [], replaceFromBase: [], useFromPose: [], addFromPose: [] } }
    await writeJson(join(output, 'pose.json'), pose)
    records.push({ id: model.id, original: Object.fromEntries(await Promise.all(Object.entries(input).map(async ([k, path]) => [k, { path: relative(source, path), sha256: await hash(path) }]))), runtime: { psd: await hash(join(output, 'model.psd')), source: await hash(join(output, 'source.png')), overrides: await hash(join(output, 'rig-overrides.json')), pose: await hash(join(output, 'pose.json')) }, ...(patches[model.id] ? { runtimePatchSha256: await hash(resolve(dirname(resolve(values['runtime-patches'])), patches[model.id])) } : {}) })
  }
  const behavior = await json(resolve(values.behavior)), dialogue = await json(resolve(values.dialogue)), available = new Set(selected.map(m => m.id))
  const check = v => {
    if (Array.isArray(v)) v.forEach(check)
    else if (v && typeof v === 'object') for (const [k, item] of Object.entries(v)) {
      if (k === 'poseId' && item !== null && !available.has(item)) throw new Error(`Unmade pose reference: ${item}`)
      if (k === 'poseVariants' && (!Array.isArray(item) || item.some(id => !available.has(id)))) throw new Error(`Unmade variant pose reference: ${item}`)
      check(item)
    }
  }
  check(behavior)
  for (const id of Object.keys(dialogue.poseTriggers ?? {})) if (id !== 'base' && !available.has(id)) throw new Error(`Unmade dialogue pose: ${id}`)
  for (const id of Object.keys(dialogue.poseLines ?? {})) if (!Object.hasOwn(dialogue.poseTriggers ?? {}, id)) throw new Error(`Unbound dialogue pose: ${id}`)
  await writeJson(join(stage, 'behavior.json'), behavior); await writeJson(join(stage, 'dialogue.ko.json'), dialogue)
  await writeJson(join(stage, 'character.json'), { schemaVersion: 1, id: values.id, label: values.label, base: { source: 'poses/waiting/source.png', psd: 'poses/waiting/model.psd', overrides: 'poses/waiting/rig-overrides.json' }, poses: selected.map(m => `poses/${m.id}/pose.json`), behavior: 'behavior.json', dialogue: 'dialogue.ko.json' })
  await writeJson(join(stage, 'provenance.json'), { schemaVersion: 1, characterId: values.id, profile: values.profile, ...(values.profile === 'trial' ? { unsupportedReactions: ['실패', '취소', '연결 끊김', '지루함', '기쁨', '몸통 클릭', '쓰다듬기 전용 포즈'] } : {}), sourceIndexSha256: await hash(join(source, 'models.json')), strategy: 'whole-model-per-pose', sharedBaseArtwork: false, models: records })
  await rename(stage, destination)
  console.log(JSON.stringify({ id: values.id, profile: values.profile, models: selected.length, output: destination }, null, 2))
} catch (e) { await rm(stage, { recursive: true, force: true }); throw e }
