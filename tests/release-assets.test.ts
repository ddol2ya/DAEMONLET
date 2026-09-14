import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runtimeAssetPaths, pruneRuntimeAssets } from '../scripts/release/runtime-assets.mjs'
import { GROUP_OFFLOAD_MAX_VRAM_GIB, seethroughProfile, vramGiBFromStats } from '../scripts/seethrough-profile.mjs'
import dependencies from '../skills/create-pet-character/external-dependencies.json'
import template from '../skills/create-pet-character/workflows/seethrough-api.json'

describe('distribution assets', () => {
  it('ships only the Gpichan manifest graph without modifying source assets', async () => {
    const files = await runtimeAssetPaths('public/characters')
    expect(files).toContain('gpichan/rigged/gpichan-expressions.psd')
    expect(files).toContain('gpichan/poses/head-tap/rig-overrides.json')
    expect(files.some(path => path.startsWith('asuma-toki-v2/'))).toBe(false)
    expect(files.some(path => path.startsWith('asuma-toki/'))).toBe(false)
    expect(files.some(path => /authoring|provenance|generation|writing-full/.test(path))).toBe(false)
    const temp = await mkdtemp(join(tmpdir(), 'release-assets-'))
    try {
      // Small manifest fixture exercises pruning and the missing-asset fail-before-delete rule.
      await mkdir(join(temp, 'pet'))
      await writeFile(join(temp, 'catalog.json'), JSON.stringify({ characters: ['pet/character.json'] }))
      await writeFile(join(temp, 'pet/character.json'), JSON.stringify({ base: { psd: 'model.psd' }, poses: [] }))
      await writeFile(join(temp, 'pet/authoring.json'), '{}')
      await expect(pruneRuntimeAssets(temp)).rejects.toThrow()
      await access(join(temp, 'pet/authoring.json'))
      await writeFile(join(temp, 'pet/model.psd'), 'runtime bytes')
      await pruneRuntimeAssets(temp)
      expect(await readFile(join(temp, 'pet/model.psd'), 'utf8')).toBe('runtime bytes')
      await expect(access(join(temp, 'pet/authoring.json'))).rejects.toThrow()
    } finally { await rm(temp, { recursive: true, force: true }) }
  })
  it('keeps the <=8 GiB resolution limits', () => {
    expect(seethroughProfile(1280, 12)).toMatchObject({ resolution: 1280, groupOffload: true })
    expect(seethroughProfile(1536, 8)).toMatchObject({ resolution: 1024, depthResolution: 720, groupOffload: true })
    expect(seethroughProfile(768, 6).resolution).toBe(768)
  })
  it.each([4, 8, 10, 12])('enables offload at %s GiB', vram => {
    expect(seethroughProfile(1280, vram).groupOffload).toBe(true)
  })
  it.each([12.0001, 16, 24, 48])('disables offload above 12 GiB (%s GiB)', vram => {
    expect(seethroughProfile(1280, vram)).toMatchObject({groupOffload: false, resolution: 1280, depthResolution: -1})
  })
  it.each([null, NaN, Infinity, 0, -1])('rejects unknown or invalid VRAM (%s)', vram => {
    expect(() => seethroughProfile(1280, vram)).toThrow(/VRAM/)
  })
  it('uses total server GPU memory, not free memory or the first CPU device', () => {
    const vram = vramGiBFromStats({devices: [{type: 'cpu', vram_total: 8 * 1024 ** 3}, {type: 'cuda', vram_total: 24 * 1024 ** 3, vram_free: 2 * 1024 ** 3}]})
    expect(vram).toBe(24)
    expect(seethroughProfile(1280, vram).groupOffload).toBe(false)
  })
  it.each([{}, {devices: null}, {devices: [{type: 'cpu', vram_total: 16 * 1024 ** 3}]}, {devices: [{type: 'cuda', vram_total: 'invalid'}]}, {devices: [{type: 'cuda', vram_total: 0}]}, {devices: [{type: 'cuda', vram_total: Infinity}]}, {devices: [{type: 'cuda', vram_total: 8 * 1024 ** 3}, {type: 'cuda', vram_total: 24 * 1024 ** 3}]}])('does not guess missing or ambiguous GPU capacity', stats => {
    expect(vramGiBFromStats(stats)).toBeNull()
  })
  it('keeps the skill policy consistent and the static example free of forced offload', () => {
    expect(dependencies.profile.groupOffload).toEqual({maximumVramGiB: GROUP_OFFLOAD_MAX_VRAM_GIB, unknownVram: 'require-explicit-capacity'})
    for (const id of ['2', '3'] as const) expect(template[id].inputs).toMatchObject({group_offload: false, auto_download: false})
  })
})
