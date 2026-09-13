import { createServer } from 'vite'
import electron from 'electron'
import { spawn } from 'node:child_process'
import { mkdir, realpath } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { resolve, relative, sep } from 'node:path'

const { values } = parseArgs({ options: { source: { type:'string' }, output: { type:'string' }, pose: { type:'string' }, motion: { type:'boolean', default:false }, contacts: { type:'boolean', default:false } } })
if (!values.source || !values.output) throw Error('Require --source <run> --output <new QA folder> [--pose <id>] [--motion]')
const workspace=await realpath(process.cwd()),source=await realpath(resolve(values.source)),output=resolve(values.output)
if (![source,output].every(p=>p.startsWith(workspace+sep))) throw Error('QA paths must be inside the workspace')
await mkdir(output,{recursive:true})
const server=await createServer({cacheDir:resolve(output,'vite-cache'),server:{host:'127.0.0.1',port:0},plugins:[{name:'source-model-capture',configureServer(server){server.middlewares.use('/source-model-capture',(_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta charset="utf-8"><title>Character production QA</title><body style="margin:0"></body>')})}}]})
try {
 await server.listen()
 const child=spawn(electron,[resolve('scripts/characters/capture-source-models.cjs')],{stdio:'inherit',env:{...process.env,SOURCE_QA_URL:`http://127.0.0.1:${server.httpServer.address().port}`,SOURCE_QA_ROOT:source,SOURCE_QA_PATH:'/'+relative(workspace,source).split(sep).join('/'),SOURCE_QA_OUTPUT:output,SOURCE_QA_POSE:values.pose??'',SOURCE_QA_MOTION:values.motion?'1':'0',SOURCE_QA_CONTACTS:values.contacts?'1':'0'}})
 const timer=setTimeout(()=>child.kill('SIGTERM'),15*60*1000)
 try{process.exitCode=await new Promise((res,rej)=>{child.once('exit',code=>res(code??1));child.once('error',rej)})}finally{clearTimeout(timer)}
}finally{await server.close()}
