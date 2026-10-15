import {expect,it} from 'vitest'
import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'

it('preserves the exact default voice bytes admitted by the Windows native runtime',async()=>{
 const defaults=await readFile(new URL('../electron/voice/base-voice-defaults.json',import.meta.url))
 const policy=JSON.parse(await readFile(new URL('../electron/voice/runtime-gguf-windows-voxcpm2.json',import.meta.url),'utf8'))
 expect(createHash('sha256').update(defaults).digest('hex')).toBe(policy.baseVoiceDefaultsSha256)
 // This intentionally fails when a Windows checkout expands the pinned LF bytes.
 expect(defaults.includes(Buffer.from('\r\n'))).toBe(false)
})
