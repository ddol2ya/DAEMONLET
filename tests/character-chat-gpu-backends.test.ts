import {afterEach,expect,it,vi} from 'vitest'
import {runtimeBackendOrder,runtimeArguments,runtimeDevice,runtimeBackendLoaded} from '../electron/main/character-chat/runtime-backends'
import {RuntimeSupervisor,RuntimeStartError,runtimeEnvironment} from '../electron/main/character-chat/RuntimeSupervisor'
import {validateStoredChats} from '../electron/main/character-chat/ConversationStore'
const entry={backend:'CUDA',executable:'llama-server.exe',launcher:'daemonlet-runtime-host.exe',backends:{CUDA:'llama-server.exe',Vulkan:'llama-server-vulkan.exe'}}
afterEach(()=>vi.restoreAllMocks())

it('selects both packaged Windows backends automatically and honors explicit selection',()=>{
 expect(runtimeBackendOrder(entry,'auto')).toEqual(['CUDA','Vulkan'])
 expect(runtimeBackendOrder(entry,'vulkan')).toEqual(['Vulkan'])
 expect(runtimeBackendOrder(entry,'cuda')).toEqual(['CUDA'])
 expect(runtimeBackendOrder({backend:'Metal',executable:'llama-server'},'auto')).toEqual(['Metal'])
 expect(runtimeArguments(entry,'Vulkan',['--list-devices'])).toEqual(['--daemonlet-backend','Vulkan','--list-devices'])
})
it('accepts GPU generations and vendors without treating CUDA diagnostics as a Vulkan device',()=>{
 expect(runtimeDevice('CUDA0: NVIDIA GeForce RTX 5090 (32768 MiB, 30000 MiB free)','CUDA')).toMatchObject({id:'CUDA0',name:'NVIDIA GeForce RTX 5090'})
 expect(runtimeDevice('ggml_vulkan: NVIDIA driver diagnostic\nVulkan0: AMD Radeon RX fixture (16384 MiB, 15000 MiB free)','Vulkan')).toMatchObject({backend:'Vulkan',id:'Vulkan0',name:'AMD Radeon RX fixture'})
 expect(runtimeDevice('Vulkan0: llvmpipe (LLVM)\nVulkan1: Intel Arc fixture','Vulkan')?.id).toBe('Vulkan1')
 expect(runtimeDevice('CPU0: AMD Ryzen\nCUDA0: NVIDIA fixture','Vulkan')).toBeNull()
 expect(runtimeBackendLoaded('CUDA0 model buffer', {backend:'Vulkan',id:'Vulkan0',name:'fixture'})).toBe(false)
 expect(runtimeBackendLoaded('Vulkan0 model buffer', {backend:'Vulkan',id:'Vulkan0',name:'fixture'})).toBe(true)
})
it('does not inherit Vulkan loader overrides or CPU device enumeration overrides',()=>{
 const env=runtimeEnvironment('C:\\runtime','win32',{SystemRoot:'C:\\Windows',VK_DRIVER_FILES:'foreign.json',VK_INSTANCE_LAYERS:'foreign',GGML_VK_VISIBLE_DEVICES:'0'})
 expect(env).not.toHaveProperty('VK_DRIVER_FILES');expect(env).not.toHaveProperty('VK_INSTANCE_LAYERS');expect(env).not.toHaveProperty('GGML_VK_VISIBLE_DEVICES')
 expect(env.VK_LOADER_LAYERS_DISABLE).toBe('~all~')
})
function fixture(preference:'auto'|'cuda'|'vulkan'='auto'){
 const runtime=new RuntimeSupervisor('/fixture/llama-server.exe');runtime.backendPreference=preference
 const probe=vi.spyOn(runtime as any,'probe').mockImplementation(async(...args:any[])=>{
  const backend=args[3]?.includes('CUDA')||preference==='vulkan'?'Vulkan':'CUDA'
  return {entry,help:'',device:{backend,id:backend+'0',name:'fixture GPU'}}
 })
 const start=vi.spyOn(runtime as any,'prepareBackend')
 return {runtime,probe,start}
}
it('cleans a failed CUDA model load before trying Vulkan once in auto mode',async()=>{
 const f=fixture();const clean=vi.spyOn(f.runtime as any,'cleanup')
 f.start.mockRejectedValueOnce(new RuntimeStartError('fixture CUDA load failed')).mockImplementationOnce(async(s:any)=>{expect(clean).toHaveBeenCalledOnce();s.ready=true})
 await f.runtime.start('/fixture/model');expect(f.probe).toHaveBeenCalledTimes(2)
 expect(f.runtime.selectedDevice?.backend).toBe('Vulkan');expect(f.runtime.backendFallback).toBe(true)
 await f.runtime.stop()
})
it.each(['cuda','vulkan'] as const)('does not change an explicitly selected %s backend on load failure',async preference=>{
 const f=fixture(preference);f.start.mockRejectedValue(new RuntimeStartError('fixture load failed'))
 await expect(f.runtime.start('/fixture/model')).rejects.toThrow('fixture load failed');expect(f.probe).toHaveBeenCalledOnce();await f.runtime.stop()
})
it('never uses fallback to bypass a catalog or model-integrity error',async()=>{
 const f=fixture();f.start.mockRejectedValue(Error('Runtime hash differs'))
 await expect(f.runtime.start('/fixture/model')).rejects.toThrow('hash differs');expect(f.probe).toHaveBeenCalledOnce();await f.runtime.stop()
})
it('fails after two unsupported backends without retry loops or CPU fallback',async()=>{
 const f=fixture();f.start.mockRejectedValue(new RuntimeStartError('fixture load failed'))
 await expect(f.runtime.start('/fixture/model')).rejects.toThrow('fixture load failed');expect(f.probe).toHaveBeenCalledTimes(2);await f.runtime.stop()
})
it('keeps old conversations readable and persists only valid backend preferences',()=>{
 const data={version:2,model:'E4B',characterId:'gpichan',conversations:[],memories:{}}
 expect(validateStoredChats(data)).not.toHaveProperty('gpuBackend')
 expect(validateStoredChats({...data,gpuBackend:'vulkan'}).gpuBackend).toBe('vulkan')
 expect(()=>validateStoredChats({...data,gpuBackend:'cpu'})).toThrow('CHAT_STORAGE_INVALID')
})
