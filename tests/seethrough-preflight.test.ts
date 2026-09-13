import {createServer} from 'node:http'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {resolve} from 'node:path'
import {expect,it} from 'vitest'
import {makeSeeThroughPrompt} from '../scripts/seethrough-workflow.mjs'
it('rejects an incompatible external installation before uploading artwork',async()=>{
  let writes=0
  const server=createServer((req,res)=>{if(req.method!=='GET')writes++;res.setHeader('Content-Type','application/json');res.end('{}')})
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r))
  try {
    const address=server.address();if(!address||typeof address==='string')throw Error('No test listener')
    const command=promisify(execFile)(process.execPath,[resolve('scripts/run-seethrough.mjs'),'nonexistent-reference.png','unused-output','1',`http://127.0.0.1:${address.port}`])
    await expect(command).rejects.toThrow('Compatible See-through nodes are missing')
    expect(writes).toBe(0)
    const graph=makeSeeThroughPrompt({name:'reference.png'},1,'test',{resolution:1024,depthResolution:720,groupOffload:true})
    for(const id of ['2','3'] as const)expect(graph[id].inputs).toMatchObject({auto_download:false,group_offload:true})
    expect(graph['6'].inputs.use_lama).toBe(false)
  } finally {await new Promise<void>(r=>server.close(()=>r()))}
})
