import {mkdir,copyFile,writeFile,rm,rename} from 'node:fs/promises'
import {resolve,join,dirname} from 'node:path'
import {runtimeTarget,selectRuntime,verifyRuntime} from '../electron/main/character-chat/runtime-artifacts.mjs'
const source=process.argv[2],target=process.argv[3] || runtimeTarget()
if(!source)throw Error('Pass an existing pinned runtime directory and optional platform-arch; no download is performed')
const catalog=selectRuntime(target),dest=resolve('.generated/character-chat-runtime-package',target)
if(resolve(source)===dest)throw Error('Source must not be the staging directory')
const pending=dest+'.staging-'+process.pid
await mkdir(pending,{recursive:true})
try {
 for(const name of Object.keys(catalog.files)) {
  await mkdir(dirname(join(pending,name)),{recursive:true})
  await copyFile(name.startsWith('licenses/')?resolve('distribution/licenses/character-chat',name.slice(9)):join(source,name),join(pending,name))
 }
 await writeFile(join(pending,'runtime-lock.json'),JSON.stringify(catalog,null,2)+'\n')
 await verifyRuntime(pending,target)
 await rm(dest,{recursive:true,force:true})
 await rename(pending,dest)
} finally {await rm(pending,{recursive:true,force:true})}
console.log(`Verified ${target} runtime staged; model weights remain external`)
