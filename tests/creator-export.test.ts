import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {mkdir,mkdtemp,rm} from 'node:fs/promises'
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
