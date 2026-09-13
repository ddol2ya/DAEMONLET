import { writeFile, mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { app, type BrowserWindow } from "electron"

type Harness = { run(script:string):Promise<any>;wait(ms:number):Promise<unknown>;until(expression:string,label:string):Promise<void>;window:BrowserWindow;evidence:string }
export async function verifyMotion(h:Harness) {
  const {run,wait,until,window,evidence}=h
  const checks:Array<{id:string;passed:boolean;details?:unknown}>=[]
  const check=(id:string,passed:boolean,details?:unknown)=>{checks.push({id,passed,...(details===undefined?{}:{details})});if(!passed)process.stderr.write(`FAILED ${id}\n`)}
  const base=()=>until("motionQa.runtime.getPoseDiagnostics().state==='BASE'","Base")
  const active=()=>until("motionQa.runtime.getPoseDiagnostics().state==='ACTIVE_LOOP'","active")
  const reset=async()=>{await run("motionQa.dispatch('RESET'); motionQa.runtime.cancelInteraction('qa-reset'); motionQa.session.behavior.setControlMode('AUTO_BEHAVIOR')");await base()}
  for(const delay of [50,150,400]) {
    await reset();await run("motionQa.dispatch('TASK_STARTED')");await wait(delay);await run("motionQa.dispatch('TASK_COMPLETED')");await wait(1200)
    check(`M05-complete-${delay}`,await run("motionQa.runtime.getPoseDiagnostics().state==='BASE' && motionQa.session.behavior.machine.getSnapshot().state==='HAPPY'"))
  }
  for(const phase of [0.25,0.5,0.75,1]) {
    await reset();await run("motionQa.dispatch('TASK_STARTED')");await until("motionQa.runtime.getPoseDiagnostics().loadStatus==='ready'","pose ready")
    await run(`motionQa.runtime.pausePoseAt(${phase})`);await run("motionQa.dispatch('TASK_CANCELLED','synthetic-A','user-interrupted')");await wait(1100)
    check(`M06-interrupt-${phase}`,await run("motionQa.runtime.getPoseDiagnostics().state==='BASE'&&motionQa.session.behavior.machine.getSnapshot().state==='NORMAL'"))
  }
  await reset();await run("motionQa.dispatch('TASK_STARTED')");await active();await run("motionQa.dispatch('TASK_CANCELLED','synthetic-A','interrupted')");await wait(150);await run("motionQa.dispatch('TASK_STARTED','synthetic-B')");await active()
  check("M06-exit-new-Run",await run("motionQa.session.behavior.machine.getSnapshot().state==='BUSY'"))
  for(const terminal of ["TASK_FAILED","TASK_CANCELLED"]) {
    await reset();await run("motionQa.dispatch('TASK_STARTED')");await run(`motionQa.dispatch('${terminal}','synthetic-A','user-interrupted');motionQa.dispatch('TASK_STARTED','synthetic-B')`);await wait(150);await run("motionQa.dispatch('TASK_COMPLETED','synthetic-B')");await wait(1300)
    check(terminal==="TASK_FAILED"?"M07-failure-restart":"M08-interrupt-restart",await run("motionQa.session.behavior.machine.getSnapshot().state==='HAPPY'&&motionQa.session.dialogue.getSnapshot().triggerId?.startsWith('run.completed')"))
  }
  for(const terminal of ["TASK_COMPLETED","TASK_CANCELLED"]) {
    await reset();await run("motionQa.dispatch('TASK_STARTED');motionQa.dispatch('TASK_STARTED','synthetic-B')");await run(`motionQa.dispatch('${terminal}','synthetic-A','user-interrupted')`)
    check(`M09-parallel-${terminal}`,await run("motionQa.session.behavior.machine.getSnapshot().state==='BUSY'"));await run("motionQa.dispatch('TASK_COMPLETED','synthetic-B')")
  }
  await reset();await run("motionQa.dispatch('TASK_STARTED')");await active()
  for(const interaction of ["HEAD_TAP","HOLD_START","PET_START"]) {
    await run(`motionQa.runtime.triggerInteraction('${interaction}')`);await wait(300)
    check(`M10-${interaction}`,await run("motionQa.runtime.getPoseDiagnostics().state==='ACTIVE_LOOP'"));await run("motionQa.runtime.cancelInteraction('qa-capture-loss')")
  }
  const scaled=join(evidence,"after","scales");await mkdir(scaled,{recursive:true})
  for(const size of [280,299,368,460,575,690,720]) {
    window.setContentSize(size,size);await wait(180)
    await writeFile(join(scaled,`bell-${size}.png`),Buffer.from(await run("motionQa.still()"),"base64"))
    check(`scale-${size}`,await run(`motionQa.snapshot().viewport.width===${size}`))
  }
  window.setContentSize(460,460)
  // Static 0/25/50/75/100% visibility graph checkpoints are not wall-clock video.
  for(const pose of ["writing","memo-check"]) {
    await reset();await run("motionQa.session.behavior.setControlMode('MANUAL_POSE')");await run(`motionQa.runtime.loadPoseById('${pose}')`)
    for(const direction of ["enter","exit"]) for(const progress of [0,.25,.5,.75,1]) {
      await run(`motionQa.runtime.${direction==='enter'?'pausePoseAt':'pausePoseExitAt'}(${progress})`);await wait(60)
      await writeFile(join(evidence,"after",`${pose}-${direction}-${progress}.png`),Buffer.from(await run("motionQa.still()"),"base64"))
    }
  }
  await reset();await run("motionQa.dispatch('TASK_STARTED')")
  for(const character of ["momo","longhair","bell"]) await run(`motionQa.load('${character}')`)
  await active();check("M11-model-switch-during-load",await run("motionQa.runtime.getDiagnostics().characterId==='bell'&&motionQa.runtime.getPoseDiagnostics().state==='ACTIVE_LOOP'"))
  await reset();await run("motionQa.source.dispatch({type:'TASK_SNAPSHOT',tasks:[{taskId:'synthetic-recovery'}]})");await active();await run("motionQa.dispatch('TASK_CANCELLED','synthetic-recovery','recovery-not-confirmed')");await base()
  check("M12-snapshot-recovery",await run("motionQa.session.behavior.machine.getSnapshot().state==='NORMAL'&&!motionQa.session.dialogue.getSnapshot().visible"))
  window.hide();await wait(250);window.show();await wait(250)
  await run("motionQa.session.setInteractionEnabled(false);motionQa.session.setInteractionEnabled(true);motionQa.session.stop()");await wait(500);await run("motionQa.session.start()");await wait(300)
  check("M13-hide-layout-resume",await run("motionQa.errors.length===0&&motionQa.snapshot().ownersValid"))
  for(const character of ["momo","longhair"]) {
    await reset();await run(`motionQa.load('${character}')`)
    for(const pose of ["writing","memo-check"]) {
      await run("motionQa.session.behavior.setControlMode('MANUAL_POSE')");await run(`motionQa.runtime.enterPose('${pose}',{waitUntil:'STARTED'})`);await active();await wait(400)
      await run("motionQa.runtime.triggerInteraction('HOLD_START')");await wait(150);await run("motionQa.runtime.cancelInteraction('qa-release')")
      await writeFile(join(evidence,"after",`${character}-${pose}.png`),Buffer.from(await run("motionQa.still()"),"base64"));check(`${character}-${pose}`,await run("motionQa.runtime.getPoseDiagnostics().registration.accepted"));await run("motionQa.runtime.exitPose()");await base()
    }
  }
  await reset();await run("motionQa.load('bell');");await run("motionQa.session.behavior.setControlMode('MANUAL_POSE'); motionQa.runtime.enterPose('writing',{waitUntil:'STARTED'})");await active()
  const decisions=JSON.parse(await readFile(join(evidence,"tuning-decisions.json"),"utf8"))
  const candidate=JSON.parse(await readFile("public/characters/bell/poses/writing/pose.json","utf8"))
  const contacts=await run(`motionQa.contacts(${JSON.stringify({before:decisions.baseline.writing.motion,after:candidate.motion})})`)
  const drift=contacts.report.after.maxAddedGripModel*460/1024
  check("composed-grip-100pct",drift<=1,{DIP:drift,targetDIP:1})
  await writeFile(join(evidence,"contact-points.json"),JSON.stringify(contacts,null,2)+"\n")
  const result={input:"synthetic local ingress and direct QA methods",timeBasis:"wall-clock except explicitly paused transition checkpoints",checks,errors:await run("motionQa.errors"),notTested:["native mouse","actual Codex Desktop stop button","OS sleep","context loss (covered by existing unit/packaged input tests)"]}
  await writeFile(join(evidence,"motion-lifecycle.json"),JSON.stringify(result,null,2)+"\n")
  process.stdout.write(`Motion verification: ${checks.filter(c=>c.passed).length}/${checks.length}\n`)
  if(checks.some(c=>!c.passed)||result.errors.length)throw new Error("Motion verification failed; see motion-lifecycle.json")
}

export async function soakMotion(h:Harness,durationMs:number) {
  const {run,wait,until,evidence}=h,started=Date.now(),cycles:any[]=[]
  let cycle=0
  while(Date.now()-started<durationMs) {
    const character=["bell","momo","longhair"][cycle%3],cycleAt=Date.now()
    await run(`motionQa.dispatch('RESET');motionQa.session.behavior.setControlMode('MANUAL_POSE');motionQa.load('${character}')`)
    for(const pose of ["writing","memo-check"]) {
      await run(`motionQa.runtime.enterPose('${pose}',{waitUntil:'STARTED'})`);await until("motionQa.runtime.getPoseDiagnostics().state==='ACTIVE_LOOP'","soak active");await wait(2500)
      await run("motionQa.runtime.triggerInteraction('PET_START')");await wait(400);await run("motionQa.runtime.cancelInteraction('soak-release');motionQa.runtime.exitPose()");await until("motionQa.runtime.getPoseDiagnostics().state==='BASE'","soak Base")
    }
    await run("motionQa.runtime.disposePose(); if(typeof gc==='function')gc()")
    const snapshot=await run("motionQa.snapshot()")
    cycles.push({cycle,atMs:Date.now()-started,character,snapshot,cpu:app.getAppMetrics().map(({type,cpu,memory})=>({type,cpu,memory}))})
    await writeFile(join(evidence,"resource-cycle.json"),JSON.stringify({kind:"wall-clock isolated Electron, actual create/delete WebGL hooks; GC requested only if exposed",requestedDurationMs:durationMs,elapsedMs:Date.now()-started,cycles,errors:await run("motionQa.errors"),completed:false},null,2)+"\n")
    process.stdout.write(`soak cycle ${++cycle} ${character} at ${Math.round((Date.now()-started)/1000)}s\n`)
    await wait(Math.max(0,30000-(Date.now()-cycleAt)))
  }
  await writeFile(join(evidence,"resource-cycle.json"),JSON.stringify({kind:"wall-clock isolated Electron, actual WebGL create/delete hooks",requestedDurationMs:durationMs,elapsedMs:Date.now()-started,cycles,errors:await run("motionQa.errors"),completed:true},null,2)+"\n")
}
