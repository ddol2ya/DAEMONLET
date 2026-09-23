import {afterEach,expect,it,vi} from 'vitest'
const rename=vi.hoisted(()=>vi.fn())
vi.mock('node:fs/promises',()=>({rename}))
import {replaceFile} from '../electron/main/character-chat/replaceFile'
afterEach(()=>{rename.mockReset();vi.useRealTimers()})
it('retries transient Windows sharing violations without deleting original',async()=>{vi.useFakeTimers();rename.mockRejectedValueOnce(Object.assign(Error('locked'),{code:'EPERM'})).mockResolvedValue(undefined);const result=replaceFile('temp','original',undefined,'win32');await vi.runAllTimersAsync();await result;expect(rename).toHaveBeenCalledTimes(2)})
it('persistent locks stop after bounded retries',async()=>{vi.useFakeTimers();rename.mockRejectedValue(Object.assign(Error('locked'),{code:'EACCES'}));const result=replaceFile('temp','original',undefined,'win32').catch(e=>e);await vi.runAllTimersAsync();expect((await result).code).toBe('EACCES');expect(rename).toHaveBeenCalledTimes(6)})
it('abort prevents a later replacement and non-Windows errors are not retried',async()=>{const c=new AbortController();c.abort();await expect(replaceFile('temp','original',c.signal,'win32')).rejects.toThrow();expect(rename).not.toHaveBeenCalled();rename.mockRejectedValue(Object.assign(Error('disk full'),{code:'ENOSPC'}));await expect(replaceFile('temp','original',undefined,'darwin')).rejects.toThrow('disk full');expect(rename).toHaveBeenCalledTimes(1)})
