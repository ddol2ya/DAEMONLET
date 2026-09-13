// Package the skill with its own executable source; no private checkout needed.
import {cp,mkdir,readFile,readdir,writeFile} from 'node:fs/promises'
import {createWriteStream} from 'node:fs'
import {join,resolve} from 'node:path'
import {parseArgs,promisify} from 'node:util'
import {execFile} from 'node:child_process'
import {pipeline} from 'node:stream/promises'
import {createHash} from 'node:crypto'
import {build} from 'esbuild'
import {ZipFile} from 'yazl'
const root=resolve(import.meta.dirname,'../..')
export async function packageCreator(requestedOutput){
 const output=resolve(requestedOutput),pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'))
 await mkdir(output,{recursive:true})
 await writeFile(join(output,'creator-build-started.json'),JSON.stringify({version:pkg.version}),{flag:'wx'})
 const skill=join(output,'stage/create-pet-character'),runtime=join(skill,'runtime')
 await cp(join(root,'skills/create-pet-character'),skill,{recursive:true,filter:p=>!/(?:^|\/)(runtime|node_modules|__pycache__)(?:\/|$)/.test(p)})
 await mkdir(runtime,{recursive:true})
 await cp(join(root,'src'),join(runtime,'src'),{recursive:true})
 await cp(join(root,'scripts/characters'),join(runtime,'scripts/characters'),{recursive:true,filter:p=>!p.includes('__pycache__')&&!p.endsWith('.pyc')})
 for(const file of ['run-seethrough.mjs','seethrough-profile.mjs','seethrough-workflow.mjs','build-seethrough-psd.mjs'])await cp(join(root,'scripts',file),join(runtime,'scripts',file))
 const graph=await build({absWorkingDir:root,stdin:{contents:"export * from './electron/main/CharacterPackAssets';export * from './electron/shared/character-pack-contract';export * from './electron/shared/character-pack-path';export * from './src/behavior/BehaviorManifest';export * from './src/dialogue/DialogueManifest'",resolveDir:root},bundle:true,platform:'node',format:'esm',write:false,metafile:true,logLevel:'silent'})
 // Renderer source also imports shared Electron geometry contracts not used by the pack validator.
 const renderer=await build({absWorkingDir:root,entryPoints:['src/main.tsx'],bundle:true,platform:'browser',write:false,outdir:'verification-build',metafile:true,external:['util'],loader:{'.png':'dataurl','.svg':'dataurl'},logLevel:'silent'})
 for(const file of new Set([...Object.keys(graph.metafile.inputs),...Object.keys(renderer.metafile.inputs)]))if(file.startsWith('electron/')){await mkdir(join(runtime,file,'..'),{recursive:true});await cp(join(root,file),join(runtime,file))}
 const dependencies={...pkg.dependencies,...Object.fromEntries(['electron','esbuild','vite','@vitejs/plugin-react'].map(k=>[k,pkg.devDependencies[k]]))}
 await writeFile(join(runtime,'package.json'),JSON.stringify({name:'daemonlet-character-runtime',version:pkg.version,private:true,type:'module',engines:pkg.engines,license:'MIT',dependencies},null,2)+'\n')
 await writeFile(join(runtime,'vite.config.mjs'),"import {defineConfig} from 'vite';import react from '@vitejs/plugin-react';export default defineConfig({plugins:[react()],server:{host:'127.0.0.1'}})\n")
 await mkdir(join(runtime,'public/characters'),{recursive:true})
 await writeFile(join(runtime,'public/characters/catalog.json'),JSON.stringify({schemaVersion:1,characters:[]})+'\n')
 await cp(join(root,'LICENSE'),join(skill,'LICENSE.txt'))
 await writeFile(join(skill,'THIRD_PARTY_NOTICES.md'), '# Creator source notices\n\nProject code: MIT, full text in LICENSE.txt. Existing Momo Motion Lab contributors attribution is preserved; its relationship to the current project name remains unverified.\n\nAnime2.5DRig: copyright 2026 hakoniwa, MIT. Full text: vendor/anime25drig/LICENSE; pinned commit and modifications: vendor/anime25drig/UPSTREAM.md. Embedded generic RGBA parts retain upstream terms.\n\nThis archive ships project and vendored source, not installed npm libraries. runtime/package-lock.json records npm dependencies installed separately; their licenses remain in the installed packages.\n\nComfyUI, See-through, weights and Gpichan images are not bundled. See external-dependencies.json for separate code/model review status. User artwork retains its own terms.\n\nFull source notices and artwork policy: https://github.com/ddol2ya/DAEMONLET/blob/main/THIRD_PARTY_NOTICES.md and https://github.com/ddol2ya/DAEMONLET/blob/main/distribution/ARTWORK-LICENSE.md .\n')
 await cp(join(root,'vendor'),join(skill,'vendor'),{recursive:true})
 const npm=process.platform==='win32'?'npm.cmd':'npm'
 await promisify(execFile)(npm,['install','--package-lock-only','--ignore-scripts','--no-audit','--no-fund'],{cwd:runtime,timeout:180000,maxBuffer:1024*1024,...(process.platform==='win32'?{shell:true}:{})})
 const zip=new ZipFile(),archive=join(output,`Daemonlet-creator-skill-${pkg.version}.zip`),inventory=[]
 async function walk(dir,prefix){for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const path=join(dir,entry.name),name=prefix+entry.name;if(entry.isDirectory())await walk(path,name+'/');else if(entry.isFile()){if(/\.(psd|safetensors|ckpt|pyc)$/.test(name)||name.includes('/node_modules/'))throw Error('Unexpected creator payload: '+name);zip.addFile(path,name,{mode:0o100644,mtime:new Date('2000-01-01')});inventory.push(name)}else throw Error('Unexpected creator payload link')}}
 await walk(skill,'create-pet-character/');zip.end();await pipeline(zip.outputStream,createWriteStream(archive,{flags:'wx'}))
 const bytes=await readFile(archive),result={archive,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),files:inventory,includesRuntime:true,includesComfyUI:false,includesModelWeights:false}
 await writeFile(join(output,'creator-build-result.json'),JSON.stringify(result,null,2)+'\n');return result
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(import.meta.filename)){
 const {values}=parseArgs({options:{output:{type:'string'}}});if(!values.output)throw Error('Require --output <new output directory>');const result=await packageCreator(values.output);console.log(JSON.stringify({...result,files:result.files.length},null,2))
}
