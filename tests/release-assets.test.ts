import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runtimeAssetPaths, pruneRuntimeAssets } from '../scripts/release/runtime-assets.mjs'
import { seethroughProfile } from '../scripts/seethrough-profile.mjs'

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
  it('limits <=8 GiB while keeping group offload enabled on every hardware profile', () => {
    expect(seethroughProfile(1280, 12)).toMatchObject({ resolution: 1280, groupOffload: true })
    expect(seethroughProfile(1536, 8)).toMatchObject({ resolution: 1024, depthResolution: 720, groupOffload: true })
    expect(seethroughProfile(768, 6).resolution).toBe(768)
    expect(seethroughProfile(1280, null).warning).toBeTruthy()
  })
})
