import {describe, expect, it} from 'vitest'
import {cp, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {scanSourceText, sourcePathFindings} from '../scripts/release/source-policy.mjs'
import {verifyArtwork} from '../scripts/release/artwork.mjs'
import {externalLicenseStatus} from '../skills/create-pet-character/scripts/license-status.mjs'
import {makeSeeThroughPrompt} from '../scripts/seethrough-workflow.mjs'
import dependencies from '../skills/create-pet-character/external-dependencies.json'

describe('public source policy', () => {
  it('detects synthetic values and concatenated literals without exposing them', () => {
    const home = '/Users/example-user/private', token = 'ghp_' + 'A'.repeat(36)
    const ip = [192, 168, 5, 9].join('.'), host = ['example-host', 'example-tail', 'ts', 'net'].join('.')
    const text = [home, token, ip, host, "'/Users/' + 'example-user/private'"].join('\n')
    const findings = scanSourceText(text, 'fixture.txt', {allowExamples: false})
    expect(findings.map(f => f.type)).toEqual(['home-path', 'credential', 'private-ip', 'private-host', 'home-path'])
    expect(findings.map(f => f.line)).toEqual([1, 2, 3, 4, 5])
    for (const secret of [home, token, ip, host]) expect(JSON.stringify(findings)).not.toContain(secret)
    expect(scanSourceText('synthetic-private-rule', 'fixture.txt', {privateMarkers: ['synthetic-private-rule']})).toEqual([{path: 'fixture.txt', line: 1, type: 'private-marker'}])
  })
  it('allows explicit examples and official model download URLs without blanket test exclusions', () => {
    expect(scanSourceText('/Users/example-user/project\nhttps://example.invalid\nhttps://huggingface.co/layerdifforg/seethroughv0.0.2_layerdiff3d', 'docs/example.md')).toEqual([])
    expect(scanSourceText('github_pat_' + 'B'.repeat(55), 'tests/example.test.ts')).toHaveLength(1)
    for (const path of ['models/model.safetensors', 'weights.onnx', 'secrets.pem', 'outputs/result.json']) expect(sourcePathFindings(path)).toHaveLength(1)
  })
})

describe('artwork scope and creator rights', () => {
  it('rejects missing, empty and altered attribution, full text and overbroad scope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'daemonlet-artwork-'))
    try {
      for (const path of ['distribution', 'public/characters', 'public/favicon.svg', 'electron/assets', 'electron/main/TrayIconData.ts', 'docs/images', 'LICENSE']) await cp(path, join(root, path), {recursive: true})
      await expect(verifyArtwork(root)).resolves.toMatchObject({license: 'CC-BY-4.0'})
      for (const path of ['public/characters/gpichan/LICENSE.txt', 'distribution/licenses/CC-BY-4.0.txt', 'distribution/ARTWORK-NOTICE.md', 'electron/assets/trayTemplate.png']) {
        const full = join(root, path), bytes = await readFile(full)
        await rm(full); await expect(verifyArtwork(root)).rejects.toThrow()
        await writeFile(full, ''); await expect(verifyArtwork(root)).rejects.toThrow()
        await writeFile(full, Buffer.concat([bytes, Buffer.from('altered')])); await expect(verifyArtwork(root)).rejects.toThrow()
        await writeFile(full, bytes)
      }
      const embeddedPath = join(root, 'electron/main/TrayIconData.ts'), embedded = await readFile(embeddedPath, 'utf8')
      await writeFile(embeddedPath, embedded.replace('iVBOR', 'AAAAA'))
      await expect(verifyArtwork(root)).rejects.toThrow('Embedded icon')
      await writeFile(embeddedPath, embedded)
      const scopePath = join(root, 'distribution/ARTWORK-SCOPE.json'), scope = JSON.parse(await readFile(scopePath, 'utf8'))
      for (const alter of [
        (value: typeof scope) => { delete value.licenseScope },
        (value: typeof scope) => { delete value.characterRights },
        (value: typeof scope) => { value.characterRights.underlyingMaterials.includedInGrant = true },
        (value: typeof scope) => { value.characterRights.underlyingMaterials.license = 'CC-BY-4.0' },
        (value: typeof scope) => { value.characterRights.underlyingMaterials.status = 'verified' },
      ]) {
        const altered = structuredClone(scope); alter(altered)
        await writeFile(scopePath, JSON.stringify(altered)); await expect(verifyArtwork(root)).rejects.toThrow('rights scope')
      }
      scope.files.push({path: 'public/characters/other/image.png', sha256: '0'.repeat(64)})
      await writeFile(scopePath, JSON.stringify(scope)); await expect(verifyArtwork(root)).rejects.toThrow('scope')
    } finally { await rm(root, {recursive: true, force: true}) }
  }, 30000)
  it('never promotes unknown model conditions based on acknowledgement or technical readiness', () => {
    const altered = structuredClone(dependencies)
    Object.assign(altered.models[1], {acknowledged: true, technicalReady: true})
    expect(externalLicenseStatus(altered)).toMatchObject({status: 'pending', installedEnvironment: 'unverified', acknowledgementGrantsRights: false})
    expect(externalLicenseStatus(altered).entries.at(-1)).toMatchObject({status: 'unverified', installedRevisionChecked: false})
    const prompt = makeSeeThroughPrompt({name: 'example.png'}, 1, 'example', {groupOffload: true, resolution: 1280, depthResolution: 720})
    expect(prompt['2'].inputs.auto_download).toBe(false)
    expect(prompt['3'].inputs.auto_download).toBe(false)
    expect(prompt['6'].inputs.use_lama).toBe(false)
  })
})
