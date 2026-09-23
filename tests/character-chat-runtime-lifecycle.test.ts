import {afterEach,expect,it,vi} from 'vitest'
import {EventEmitter} from 'node:events'
import type {ChildProcess} from 'node:child_process'
import {RuntimeSupervisor,stopOwnedProcess,runtimeEnvironment} from '../electron/main/character-chat/RuntimeSupervisor'
const deferred=()=>{let resolve!:(value?:any)=>void;const promise=new Promise<any>(r=>resolve=r);return {promise,resolve}}
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers()})
it('stop during an unresolved probe waits for cancellation and never starts a child',async()=>{
 const runtime=new RuntimeSupervisor('/runtime/llama-server'),gate=deferred(),entered=deferred()
 vi.spyOn(runtime as any,'probe').mockImplementation(async()=>{entered.resolve();await gate.promise;return {help:'',entry:{backend:'Metal'}}})
 const start=runtime.start('/model').catch(e=>e)
 await entered.promise
 const stopped=runtime.stop();gate.resolve()
 expect((await start).name).toBe('AbortError');await stopped
 expect((runtime as any).owned.size).toBe(0)
})
it('old cancelled startup cannot clear a newer launch',async()=>{
 const runtime=new RuntimeSupervisor('/runtime/llama-server'),gate=deferred(),entered=deferred()
 vi.spyOn(runtime as any,'prepare').mockImplementationOnce(async(s:any)=>{entered.resolve();await gate.promise;s.abort.signal.throwIfAborted()}).mockImplementationOnce(async(s:any)=>{s.ready=true})
 const first=runtime.start('/first').catch(e=>e);await entered.promise
 const second=runtime.start('/second');gate.resolve();await first;await second
 expect((runtime as any).current.model).toBe('/second');expect((runtime as any).current.ready).toBe(true)
 await runtime.stop()
})
it('concurrent stop calls share cleanup for the owned launch',async()=>{
 const runtime=new RuntimeSupervisor('/runtime/llama-server'),gate=deferred()
 vi.spyOn(runtime as any,'prepare').mockResolvedValue(undefined)
 await runtime.start('/model')
 const cleanup=vi.spyOn(runtime as any,'cleanup').mockImplementation(async()=>{await gate.promise})
 const a=runtime.stop(),b=runtime.stop();await Promise.resolve();gate.resolve();await Promise.all([a,b]);expect(cleanup).toHaveBeenCalledTimes(1)
})
function child(){const c=Object.assign(new EventEmitter(),{pid:42,exitCode:null,signalCode:null,kill:vi.fn(()=>true)});return c as unknown as ChildProcess}
it('spawn failure without a PID has no exit wait',async()=>{const c=child();(c as any).pid=undefined;await stopOwnedProcess(c);expect(c.kill).not.toHaveBeenCalled()})
it('termination has a bounded failure when the child never exits',async()=>{vi.useFakeTimers();const c=child();const result=stopOwnedProcess(c).catch(e=>e);await vi.advanceTimersByTimeAsync(8000);expect((await result).message).toContain('종료');expect(c.kill).toHaveBeenCalledWith('SIGKILL')})
it('normal exit clears the forced termination timer',async()=>{vi.useFakeTimers();const c=child();const result=stopOwnedProcess(c);c.emit('exit',0,null);await result;await vi.advanceTimersByTimeAsync(10000);expect(c.kill).toHaveBeenCalledTimes(1)})
it('Windows child PATH excludes toolkit, developer folders and inherited backend overrides',()=>{
 const env=runtimeEnvironment('C:\\runtime','win32',{SystemRoot:'C:\\Windows',Path:'C:\\CUDA;C:\\VS',GGML_BACKEND_DL_PATH:'C:\\other',CUDA_VISIBLE_DEVICES:'',LLAMA_ARG_CTX_SIZE:'512',HF_TOKEN:'secret'} as any)
 expect(env.PATH).toBe('C:\\runtime;C:\\Windows\\System32;C:\\Windows');expect(env).not.toHaveProperty('Path');expect(env).not.toHaveProperty('HF_TOKEN');expect(env).not.toHaveProperty('GGML_BACKEND_DL_PATH')
})
it('Windows graceful stop closes the lifetime pipe before escalating to forced termination',async()=>{vi.useFakeTimers();const c=child(),end=vi.fn();(c as any).stdin={end};const stopped=stopOwnedProcess(c,'win32');expect(end).toHaveBeenCalledOnce();expect(c.kill).not.toHaveBeenCalled();c.emit('exit',0,null);await stopped;await vi.advanceTimersByTimeAsync(8000);expect(c.kill).not.toHaveBeenCalled()})
it('a cancelled availability probe does not misclassify the GPU as unavailable',async()=>{
 const runtime=new RuntimeSupervisor('/runtime/llama-server'),entered=deferred()
 runtime.availabilityError='previous diagnostic'
 vi.spyOn(runtime as any,'probe').mockImplementation(async(...args:unknown[])=>{const signal=args[0] as AbortSignal;entered.resolve();await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))})
 const available=runtime.available().catch(e=>e);await entered.promise;await runtime.stop()
 expect((await available).name).toBe('AbortError');expect(runtime.availabilityError).toBe('previous diagnostic')
})
