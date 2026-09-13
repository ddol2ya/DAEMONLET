import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {mkdir,mkdtemp,rm,readFile,writeFile} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {expect,it} from 'vitest'
import {packFiles,writePayload} from './helpers/character-pack'
import {validatePackDirectory} from '../electron/main/CharacterPackAssets'
import {extractCharacterPack} from '../electron/main/CharacterPackArchive'
it('exports a source payload into a pack accepted by the application validator',async()=>{
  const root=await mkdtemp(join(tmpdir(),'daemonlet-export-'))
  try {
    const payload=await writePayload(join(root,'input'),packFiles({id:'creator-fixture'}).filter(e=>e.path!=='pack.json'))
    const output=join(root,'fixture.petchar')
    await promisify(execFile)(process.execPath,[resolve('scripts/characters/export-pack.mjs'),'--character-root',payload,'--version','0.1.0','--output',output],{cwd:process.cwd(),timeout:30000})
    await mkdir(join(root,'validated'))
    await extractCharacterPack(output,join(root,'validated'))
    const pack=await validatePackDirectory(join(root,'validated/payload'),{rig:true})
    expect(pack.manifest.id).toBe('creator-fixture')
    expect(pack.manifest.version).toBe('0.1.0')
    await expect(promisify(execFile)(process.execPath,[resolve('scripts/characters/export-pack.mjs'),'--character-root',payload,'--version','0.1.0','--output',output])).rejects.toThrow()
  } finally {await rm(root,{recursive:true,force:true})}
},45000)

for (const kind of ['gpichan', 'third-party', 'unknown']) it(`preserves ${kind} attribution without assigning another pack's license`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'daemonlet-notice-export-'))
  try {
    const payload = await writePayload(join(root, 'input'), packFiles({id: 'notice-fixture'}).filter(e => e.path !== 'pack.json'))
    const notice = kind === 'gpichan' ? await readFile('public/characters/gpichan/LICENSE.txt') : kind === 'third-party' ? Buffer.from('Example author; separate third-party conditions.\n') : undefined
    if (notice) await writeFile(join(payload, 'LICENSE.txt'), notice)
    const output = join(root, 'fixture.petchar')
    await promisify(execFile)(process.execPath, [resolve('scripts/characters/export-pack.mjs'), '--character-root', payload, '--version', '0.1.0', '--output', output], {timeout: 30000})
    await mkdir(join(root, 'validated')); await extractCharacterPack(output, join(root, 'validated'))
    const pack = await validatePackDirectory(join(root, 'validated/payload'), {rig: true})
    expect(pack.manifest.files.some(f => f.path === 'LICENSE.txt')).toBe(Boolean(notice))
    if (notice) expect(await readFile(join(root, 'validated/payload/LICENSE.txt'))).toEqual(notice)
  } finally { await rm(root, {recursive: true, force: true}) }
}, 45000)
