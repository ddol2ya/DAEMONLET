import {readFile,mkdir,copyFile,writeFile,rm,cp} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {resolve,join} from 'node:path'
const source=process.argv[2],dest=resolve('.generated/character-chat-runtime-package');if(!source)throw Error('Pass an existing pinned llama.cpp bin directory; no download is performed')
const catalog=JSON.parse(await readFile(new URL('../electron/main/character-chat/runtime-catalog.json',import.meta.url),'utf8'));if(`${process.platform}-${process.arch}`!==catalog.platform)throw Error('No validated runtime catalog for this platform')
for(const [name,sha] of Object.entries(catalog.files)){const bytes=await readFile(join(source,name));if(createHash('sha256').update(bytes).digest('hex')!==sha)throw Error('Runtime hash mismatch: '+name)}
if(resolve(source)===dest)throw Error('Source must not be the staging directory');await rm(dest,{recursive:true,force:true});await mkdir(dest,{recursive:true});for(const name of Object.keys(catalog.files))await copyFile(join(source,name),join(dest,name));await writeFile(join(dest,'runtime-lock.json'),JSON.stringify(catalog,null,2)+'\n');await cp('distribution/licenses/character-chat',join(dest,'licenses'),{recursive:true});console.log('Verified runtime staged; model weights remain external')
