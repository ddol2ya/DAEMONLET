import {beforeEach,expect,it,vi} from 'vitest'
import {createHash} from 'node:crypto'
const files=vi.hoisted(()=>new Map<string,string|Buffer>())
vi.mock('node:fs/promises',()=>({readFile:vi.fn(async (path:string)=>{for(const [suffix,value] of files)if(path.endsWith(suffix))return value;throw Error('ENOENT')})}))
import config from '../forge.config.mjs'
const binary=Buffer.from('synthetic executable')
const catalog={platform:'darwin-arm64',files:{'llama-server':createHash('sha256').update(binary).digest('hex')}}
const verify=(platform='darwin',arch='arm64')=>config.hooks.prePackage({},platform,arch)
beforeEach(()=>{files.clear();files.set('runtime-catalog.json',JSON.stringify(catalog));files.set('runtime-lock.json',JSON.stringify(catalog));files.set('llama-server',binary)})
it('accepts matching target and pinned native bytes',async()=>{await expect(verify()).resolves.toBeUndefined()})
it('rejects unsupported targets',async()=>{await expect(verify('win32','x64')).rejects.toThrow('No validated')})
it('requires a staged native runtime for app packaging',async()=>{files.delete('runtime-lock.json');await expect(verify()).rejects.toThrow('Stage the pinned')})
it('rejects a different runtime catalog or modified native bytes',async()=>{files.set('runtime-lock.json','{}');await expect(verify()).rejects.toThrow('catalog differs');files.set('runtime-lock.json',JSON.stringify(catalog));files.set('llama-server',Buffer.from('changed'));await expect(verify()).rejects.toThrow('hash differs')})
