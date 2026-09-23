import {spawn} from 'node:child_process'
import {readFile,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import assert from 'node:assert/strict'
const root=process.argv[3]||process.argv[2],state=join(root,'owner-state.json')
if(process.argv[2]==='owner'){
 const child=spawn(join(root,'daemonlet-runtime-host.exe'),['한글 (공백)','a"b','끝\\'],{stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false,cwd:root})
 let text='';child.stdout.on('data',async b=>{text+=b; if(text.includes('ARG:끝\\')){await writeFile(state,JSON.stringify({hostPid:child.pid,serverPid:Number(/PID:(\d+)/.exec(text)[1]),text}));process.exit(0)}})
 child.stderr.pipe(process.stderr);setTimeout(()=>process.exit(2),10000)
}else{
 const parent=spawn(process.execPath,[import.meta.filename,'owner',root],{stdio:['ignore','pipe','pipe'],windowsHide:true})
 let errors='';parent.stderr.on('data',b=>errors+=b)
 const code=await new Promise(r=>parent.on('exit',r));assert.equal(code,0,errors)
 const record=JSON.parse(await readFile(state,'utf8'))
 assert.ok(record.text.includes('ARG:한글 (공백)'));assert.ok(record.text.includes('ARG:a"b'));assert.ok(record.text.includes('ARG:끝\\'))
 function alive(pid){try{process.kill(pid,0);return true}catch{return false}}
 const deadline=Date.now()+5000
 while((alive(record.hostPid)||alive(record.serverPid))&&Date.now()<deadline)await new Promise(r=>setTimeout(r,50))
 assert.ok(!alive(record.hostPid),'host survived parent EOF');assert.ok(!alive(record.serverPid),'server survived job closure')
 console.log(JSON.stringify({...record,result:'passed',evidenceKind:'native-synthetic-owner',note:'Not a real model/UI acceptance result'}))
}
