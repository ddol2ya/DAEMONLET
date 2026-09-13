// Rules contain categories only. Findings never contain matched source text.
const rules = [
  ['home-path', /(?:[A-Z]:[\\/]+Users[\\/]+|(?<![\w/])\/(?:Users|home)\/)([\w.-]+)/gi],
  ['private-host', /\b(?:[\w-]+\.)+[\w-]+\.ts\.net\b|\b[\w-]+\.local\b/gi],
  ['private-ip', /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/g],
  ['private-workspace', /\b[A-Z]:[\\/]+(?:ComfyUI[^\s'"`;,)]*|Projects[\\/]+[^\s'"`;,)]*)/gi],
  ['credential', /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{50,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}|\bAKIA[A-Z0-9]{16}\b/g],
]

function sourcePathFindings(path) {
  return /(^|\/)(outputs|node_modules|\.codex|\.agents|__pycache__)(\/|$)|(^|\/)\.env|\.(p12|p8|pem|safetensors|ckpt|pt|pth|onnx|gguf|pyc)$/i.test(path)
    ? [{path, line: 1, type: 'private-or-generated-file'}] : []
}

/** @param {string} text @param {string} path @param {{privateMarkers?: string[], allowExamples?: boolean}} [options] */
function scanSourceText(text, path, {privateMarkers = [], allowExamples = true} = {}) {
  const findings = []
  for (const [index, raw] of text.split('\n').entries()) {
    // Fold adjacent quoted fragments without evaluating code or changing line numbers.
    const line = raw.replace(/(['"])\s*\+\s*\1/g, '').replaceAll('\\\\', '\\')
    for (const [type, pattern] of rules) {
      pattern.lastIndex = 0
      for (const match of line.matchAll(pattern)) {
        // Reserved, explicit example identities only; no directory-wide exemptions.
        if (allowExamples && type === 'home-path' && /^(example-user|user|test|runner|Public|Default)$/i.test(match[1])) continue
        findings.push({path, line: index + 1, type}); break
      }
    }
    if (privateMarkers.some(value => raw.includes(value) || line.includes(value))) findings.push({path, line: index + 1, type: 'private-marker'})
  }
  return findings
}

import {execFileSync} from 'node:child_process'
import {lstat,readFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {runtimeAssetPaths} from './runtime-assets.mjs'
const root=resolve(import.meta.dirname,'../..')
const gitRoot=execFileSync('git',['rev-parse','--show-toplevel'],{cwd:root,encoding:'utf8'}).trim()
if(resolve(gitRoot)!==root)throw Error('Run this check inside the independent DAEMONLET repository')
const files=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean)
const failures=[]
const runtime=new Set((await runtimeAssetPaths(resolve(root,'public/characters'))).map(p=>'public/characters/'+p))
for(const file of files){
 if(/(^|\/)(outputs|node_modules|\.codex|\.agents|__pycache__)(\/|$)|(^|\/)\.env|\.(p12|p8|pem|safetensors|ckpt|pyc)$/.test(file))failures.push('Private/generated material: '+file)
 if(file.startsWith('public/characters/')&&!runtime.has(file))failures.push('Unselected character asset: '+file)
 const path=resolve(root,file),info=await lstat(path)
 if(!info.isFile()){failures.push('Unexpected link or non-file: '+file);continue}
 if(info.size>50*1024*1024)failures.push('Unexpected large source file: '+file)
 if(!/\.(png|psd|icns|jpg|webp)$/.test(file)){
  const s=await readFile(path,'utf8')
  // Detect categories without embedding private environment literals.
  if(scanSourceText(s,file).length)failures.push('Personal environment data: '+file)
  if(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}/.test(s))failures.push('Possible credential: '+file)
 }
}
const pkg=JSON.parse(await readFile(resolve(root,'package.json'),'utf8'))
if(pkg.name!=='daemonlet-for-codex'||pkg.productName!=='Daemonlet for Codex')failures.push('Wrong product identity')
console.log(JSON.stringify({files:files.length,runtimeAssets:runtime.size,failures},null,2))
if(!files.length||failures.length)process.exitCode=1
