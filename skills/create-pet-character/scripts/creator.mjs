#!/usr/bin/env node
import {access,readFile} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {spawn} from 'node:child_process'
import {createRequire} from 'node:module'
import {externalLicenseStatus} from './license-status.mjs'
const skill=resolve(import.meta.dirname,'..')
const source=resolve(skill,'../..')
const candidates=process.env.DAEMONLET_CREATOR_RUNTIME?[resolve(process.env.DAEMONLET_CREATOR_RUNTIME)]:[join(skill,'runtime'),source]
let runtime,pkg
for(const candidate of candidates){try{const value=JSON.parse(await readFile(join(candidate,'package.json'),'utf8'));if(['daemonlet-for-codex','daemonlet-character-runtime'].includes(value.name)){runtime=candidate;pkg=value;break}}catch{}}
if(!runtime)throw Error('Creator runtime missing. Install the complete skill ZIP or set DAEMONLET_CREATOR_RUNTIME to the DAEMONLET source checkout.')
const actions={motion:'scripts/characters/author-motion.mjs',review:'scripts/characters/production-review.mjs','validate-persona':'scripts/characters/validate-persona.mjs','upgrade-persona':'scripts/characters/upgrade-pack-persona.mjs',decompose:'scripts/run-seethrough.mjs',build:'scripts/characters/build-source-models.py',finish:'scripts/characters/finish-source-models.py',capture:'scripts/characters/capture-source-models.mjs',verify:'scripts/characters/verify-independent.mjs',payload:'scripts/characters/build-independent-payload.mjs',export:'scripts/characters/export-pack.mjs'}
const [action='info',...args]=process.argv.slice(2)
if(action==='info'){console.log(JSON.stringify({version:pkg.version,runtime,output:join(runtime,'outputs/characters'),tools:Object.keys(actions)},null,2))}
else if(action==='check'){
 const errors=[],require=createRequire(join(runtime,'package.json'))
 for(const tool of [...Object.values(actions),'src/engine/anime25d/PsdRigLoader.ts','scripts/characters/verify-independent-browser.mjs','scripts/characters/lib/prepare.py'])try{await access(join(runtime,tool))}catch{errors.push('Missing runtime file: '+tool)}
 for(const dep of ['ag-psd','esbuild','vite','electron','yauzl','yazl'])try{require.resolve(dep)}catch{errors.push('Run npm ci in the creator runtime: '+dep)}
 const dependencies=JSON.parse(await readFile(join(skill,'external-dependencies.json'),'utf8'))
 console.log(JSON.stringify({runtime,errors,technicalReadiness:errors.length?'not-ready':'runtime-ready',licenseReview:externalLicenseStatus(dependencies),externalTools:'ComfyUI, See-through, models and Python are checked separately; nothing was downloaded'},null,2));if(errors.length)process.exitCode=1
}else{
 const tool=actions[action];if(!tool)throw Error('Unknown creator action. Use info, check, '+Object.keys(actions).join(', '))
 if(action==='payload'&&!args.includes('--reviewed'))args.push('--reviewed')
 const python=process.env.DAEMONLET_CREATOR_PYTHON||(process.platform==='win32'?'python':'python3')
 const child=spawn(tool.endsWith('.py')?python:process.execPath,[join(runtime,tool),...args],{cwd:runtime,env:process.env,stdio:'inherit',shell:false})
 child.once('error',e=>{console.error(e.message);process.exitCode=1});child.once('exit',code=>{process.exitCode=code??1})
}
