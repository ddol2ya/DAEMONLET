import {afterEach,expect,it} from 'vitest'
import {createHash} from 'node:crypto'
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {selectRuntime,verifyRuntime,runtimeTarget} from '../electron/main/character-chat/runtime-artifacts.mjs'
import config from '../forge.config.mjs'
const roots:string[]=[]
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})))})
async function fixture(target='win32-x64') {
 const root=await mkdtemp(join(tmpdir(),'chat-runtime-'));roots.push(root)
 const binary=Buffer.alloc(128);binary.write('MZ');binary.writeUInt32LE(64,60);binary.writeUInt32LE(0x4550,64);binary.writeUInt16LE(0x8664,68)
 const name=target==='win32-x64'?'llama-server.exe':'llama-server'
 const bytes:Record<string,Buffer>={[name]:binary,'ggml-cuda.dll':binary,'licenses/runtime.txt':Buffer.from('synthetic test notice')}
 const entry={platform:target,executable:name,files:Object.fromEntries(Object.entries(bytes).map(([name,b])=>[name,{bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')}]))}
 const trusted={schemaVersion:2,targets:{[target]:entry}} as any
 await mkdir(join(root,'licenses'))
 for(const [name,b] of Object.entries(bytes))await writeFile(join(root,name),b)
 await writeFile(join(root,'runtime-lock.json'),JSON.stringify(entry))
 return {root,trusted,entry,verify:()=>verifyRuntime(root,target,{trusted})}
}
it('validates synthetic Windows x64 PE, DLL and notice allowlist without native execution',async()=>{const f=await fixture();await expect(f.verify()).resolves.toEqual(f.entry)})
it('rejects unknown target and never substitutes the Mac catalog',()=>{expect(runtimeTarget('win32','x64')).toBe('win32-x64');expect(()=>selectRuntime('linux-x64')).toThrow('No validated')})
it('requires a lock and rejects a self-authored different lock',async()=>{const f=await fixture();await rm(join(f.root,'runtime-lock.json'));await expect(f.verify()).rejects.toThrow('Stage the pinned');await writeFile(join(f.root,'runtime-lock.json'),'{}');await expect(f.verify()).rejects.toThrow('catalog differs')})
it('rejects missing DLLs, extra loader files and omitted notices',async()=>{for(const name of ['ggml-cuda.dll','licenses/runtime.txt']){const f=await fixture();await rm(join(f.root,name));await expect(f.verify()).rejects.toThrow('allowlist')}const f=await fixture();await writeFile(join(f.root,'nvcuda.dll'),'driver');await expect(f.verify()).rejects.toThrow('allowlist')})
it('rejects wrong bytes even with matching sizes',async()=>{const f=await fixture();await writeFile(join(f.root,'llama-server.exe'),Buffer.alloc(128));await expect(f.verify()).rejects.toThrow('hash differs')})
it('rejects non-x64 PE even when synthetic digest matches',async()=>{const f=await fixture();const bytes=Buffer.alloc(128);await writeFile(join(f.root,'llama-server.exe'),bytes);f.entry.files['llama-server.exe'].sha256=createHash('sha256').update(bytes).digest('hex');await writeFile(join(f.root,'runtime-lock.json'),JSON.stringify(f.entry));await expect(f.verify()).rejects.toThrow('AMD64')})
it.skipIf(process.platform==='win32')('rejects a substituted symbolic link',async()=>{const f=await fixture();await rm(join(f.root,'ggml-cuda.dll'));await symlink(join(f.root,'llama-server.exe'),join(f.root,'ggml-cuda.dll'));await expect(f.verify()).rejects.toThrow('link')})
it('does not embed the separately verified native runtime in ASAR',()=>{expect(config.packagerConfig.ignore('/dist-electron/local-llm')).toBe(true);expect(config.packagerConfig.ignore('/dist-electron/local-llm/llama-server.exe')).toBe(true);expect(config.packagerConfig.ignore('/dist-electron/main.cjs')).toBe(false)})
it('rejects the Windows shared-library/static-CRT combination that fails at model IO',async()=>{const f=await fixture();(f.entry as any).build={sharedLibraries:true,msvcRuntime:'MultiThreaded'};await writeFile(join(f.root,'runtime-lock.json'),JSON.stringify(f.entry));await expect(f.verify()).rejects.toThrow('shared-library/static-CRT')})
