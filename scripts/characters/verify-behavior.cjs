const { app, BrowserWindow } = require('electron')
const fs = require('node:fs'), path = require('node:path')
const output = path.join(process.env.INDEPENDENT_QA_OUTPUT, 'behavior')
fs.mkdirSync(output, { recursive: true })
app.setPath('userData', path.join(output, 'profile'))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms)), q = JSON.stringify
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 520, height: 540, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } })
  const run = code => win.webContents.executeJavaScript(`(async()=>{${code}})()`, true)
  const events = [], errors = []
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message) })
  const waitFor = async (code, label) => {
    const until = Date.now()+30000
    while (Date.now()<until) { if (await run(`return ${code}`)) return; await delay(40) }
    throw new Error('Timed out: '+label)
  }
  const active = id => waitFor(id === 'base' ? 'qs.runtime.getPoseDiagnostics().state === "BASE"' : `qs.runtime.getPoseDiagnostics().state === 'ACTIVE_LOOP' && qs.runtime.getActivePoseId() === ${q(id)}`, id)
  const capture = async (name, pose) => {
    await delay(100)
    const value = await run(`return {png:qs.canvas.toDataURL('image/png'),pose:qs.runtime.getPoseDiagnostics(),behavior:qs.behavior.getDiagnostics(),dialogue:qs.dialogue.getSnapshot(),resources:qs.runtime.getResourceDiagnostics()}`)
    fs.writeFileSync(path.join(output,name+'.png'),Buffer.from(value.png.split(',')[1],'base64'));delete value.png
    if (pose && value.pose.id !== pose) throw new Error('Unexpected pose '+value.pose.id)
    if (value.pose.error || value.resources.cachedPoseAssetCount>5 || value.resources.outgoingPoseGpuResources>30) throw new Error('Invalid runtime state')
    if (pose && value.pose.sharedBaseLayers.length) throw new Error('Foreign Base layers are active')
    events.push({step:name,pose:value.pose.id,state:value.pose.state,resources:value.resources,dialogue:value.dialogue.triggerId})
    fs.writeFileSync(path.join(output,name+'.json'),JSON.stringify(value,null,2)+'\n')
    console.log(name)
  }
  const dispatch = event => run(`source.dispatch(${q(event)});return true`)
  const task = async (event, pose, name) => { await dispatch(event); await active(pose); await capture(name,pose==='base'?undefined:pose) }
  let idleId = 'base', inputPoints = {}
  const at = async (type, kind, pose = idleId === 'base' ? 'waiting' : idleId) => {
    // Read the loaded model's effective areas, including historical models that
    // predate explicit source overrides. Cache points so release uses the same
    // coordinates even after an interaction changes the active pose.
    if (!inputPoints[pose]) inputPoints[pose] = await run(`
      const resolver=qs.runtime.getHitAreaResolver(),a=resolver?.areas;
      if(!a?.head||!a.face||!a.torso)throw Error('Missing runtime input areas');
      const center=v=>[(v.x0+v.x1)/2,(v.y0+v.y1)/2],x=t=>a.head.x0+(a.head.x1-a.head.x0)*t;
      const y=[.5,.25,.1].map(t=>a.head.y0+(a.head.y1-a.head.y0)*t).find(y=>resolver.resolve(x(.4),y)==='head'&&resolver.resolve(x(.7),y)==='head');
      if(y===undefined)throw Error('No head-only stroke inside effective input areas');
      const points={face:center(a.face),torso:center(a.torso),petStart:[x(.4),y],petEnd:[x(.7),y]};
      for(const kind of ['face','torso'])if(resolver.resolve(...points[kind])!==kind)throw Error('Overlapping input center: '+kind);
      return points;
    `)
    await pointer(type, ...inputPoints[pose][kind])
  }
  let pressed = false
  const pointer = async (type,x,y) => {
    const point = await run(`const r=qs.canvas.getBoundingClientRect();return{x:Math.round(r.x+${x}*r.width/1280),y:Math.round(r.y+${y}*r.height/1280)}`)
    if(type==='mouseDown')pressed=true
    win.webContents.sendInputEvent({type,...point,modifiers:pressed?['leftButtonDown']:[],...(type==='mouseMove'?{}:{button:'left',clickCount:1})})
    if(type==='mouseUp')pressed=false
  }
  try {
    await win.loadURL(process.env.INDEPENDENT_QA_URL+'/independent-model-qa')
    await run(`const [{CharacterSession},{MockTaskEventSource}]=await Promise.all([import('/src/runtime/CharacterSession.ts'),import('/src/behavior/MockTaskEventSource.ts')]);const canvas=document.createElement('canvas');canvas.style.cssText='width:460px;height:460px;margin:20px';document.body.append(canvas);window.qs=new CharacterSession(canvas);window.source=new MockTaskEventSource();qs.connectTaskSource(source);qs.start();await qs.loadCharacter(${q(process.env.INDEPENDENT_QA_ID)});qs.dialogue.setAvailable(true);return true`)
    idleId = await run(`const u=new URL('/characters/'+${q(process.env.INDEPENDENT_QA_ID)}+'/character.json',location.href),c=await(await fetch(u)).json(),b=c.behavior?await(await fetch(new URL(c.behavior,u))).json():{};window.qaBehavior=b;window.qaPoseCount=c.poses.length;return b.states?.NORMAL?.poseId??'base'`)
    await active(idleId);await capture('01-idle')
    const initial = await run('return {character:qs.runtime.getDiagnostics().characterId,poses:qs.runtime.listPoses(),warnings:qs.behavior.getDiagnostics().warnings}')
    if(initial.poses.length!==await run('return qaPoseCount'))throw new Error('Missing poses')
    await task({type:'TASK_STARTED',taskId:'qa-1'},'writing','02-writing')
    await task({type:'TASK_WAITING',taskId:'qa-1'},'waiting','03-waiting')
    await task({type:'TASK_RESUMED',taskId:'qa-1'},'writing','04-resumed')
    await task({type:'TASK_FAILED',taskId:'qa-1'},'failed','05-failed');await active(idleId)
    await task({type:'TASK_STARTED',taskId:'qa-2'},'writing','06-writing-again')
    await task({type:'TASK_CANCELLED',taskId:'qa-2',reason:'user-interrupted'},'cancelled','07-cancelled');await active(idleId)
    await task({type:'TASK_STARTED',taskId:'qa-3'},'writing','08-writing-before-complete')
    await task({type:'TASK_COMPLETED',taskId:'qa-3',confidence:'observed'},'happy','09-happy');await active(idleId)
    await task({type:'CONNECTION_CHANGED',connected:false},'disconnected','10-disconnected')
    await task({type:'CONNECTION_CHANGED',connected:true},idleId,'11-reconnected')
    await run('qs.behavior.advance(65000);return true');await active('bored');await capture('12-bored','bored')
    await dispatch({type:'USER_ACTIVITY',source:'debug'});await active(idleId)
    for(const [kind,event,prefix] of [['face','HEAD_TAP','13'],['torso','TORSO_TAP','14']]){
      const choices=await run(`const a=qaBehavior.interactionReactions?.[${q(event)}];if(!a?.poseId)throw Error('Full profile requires '+${q(event)});return [a.poseId,...(a.poseVariants??[])]`)
      const seen=new Set()
      for(let i=0;i<choices.length;i++){
        await at('mouseDown',kind);await delay(65);await at('mouseUp',kind)
        await waitFor(`qs.runtime.getPoseDiagnostics().state==='ACTIVE_LOOP'&&${q(choices)}.includes(qs.runtime.getActivePoseId())`,event)
        const selected=await run('return qs.runtime.getActivePoseId()')
        if(seen.has(selected))throw Error('Repeated variant before bag exhausted: '+event)
        seen.add(selected);await capture(prefix+'-'+selected,selected);await active(idleId)
      }
    }
    await at('mouseDown','petStart');await at('mouseMove','petEnd');await active(await run("return qaBehavior.continuousReactions?.PET?.poseId??(qaBehavior.states?.NORMAL?.poseId??'base')"));await capture('15-head-pet')
    await at('mouseUp','petEnd');await active(idleId)
    await at('mouseDown','face');await delay(700);await capture('16-face-hold')
    if(await run('return qs.runtime.getActivePoseId()')!==(idleId==='base'?null:idleId))throw new Error('Face hold changed the body pose')
    await at('mouseUp','face');await delay(350)
    await task({type:'TASK_STARTED',taskId:'qa-busy'},'writing','17-busy')
    await at('mouseDown','petStart','writing');await at('mouseMove','petEnd','writing');await active(await run("return qaBehavior.continuousReactions?.PET?.poseId??'writing'"));await capture('18-busy-pet')
    await task({type:'TASK_CANCELLED',taskId:'qa-busy',reason:'user-interrupted'},'cancelled','19-work-preempts-pet')
    await at('mouseUp','petEnd');await active(idleId)
    await run(`source.dispatch({type:'TASK_STARTED',taskId:'qa-burst'});source.dispatch({type:'TASK_WAITING',taskId:'qa-burst'});return true`)
    await active('waiting');await capture('20-latest-request-wins','waiting')
    await dispatch({type:'RESET'});await active(idleId)
    const switches=[]
    const peers=await run(`const catalog=await(await fetch('/characters/catalog.json')).json();return (await Promise.all(catalog.characters.map(async ref=>(await(await fetch('/characters/'+ref)).json()).id))).filter(id=>id!==${q(process.env.INDEPENDENT_QA_ID)})`)
    for(const id of [...peers.slice(0,1),process.env.INDEPENDENT_QA_ID]) {
      await run(`await qs.loadCharacter(${q(id)});return true`);await active(id===process.env.INDEPENDENT_QA_ID?idleId:'base')
      const state=await run('return {character:qs.runtime.getDiagnostics().characterId,resources:qs.runtime.getResourceDiagnostics(),pose:qs.runtime.getPoseDiagnostics()}')
      if(state.character!==id||state.pose.error||state.resources.cachedPoseAssetCount>5)throw new Error('Character switch failed')
      switches.push(state)
    }
    await capture('21-character-return')
    const released=await run('qs.dispose();source.dispose();return qs.runtime.getResourceDiagnostics()')
    for(const key of ['meshCount','textureCount','bufferCount','framebufferCount','renderbufferCount','poseWaiterCount','cachedPoseAssetCount','motionSourceCount'])if(released[key]!==0)throw new Error('Resource retained: '+key)
    if(errors.length)throw new Error(errors.join('\n'))
    fs.writeFileSync(path.join(output,'verification.json'),JSON.stringify({status:'passed',initial,idleId,inputPoints,events,switches,released,consoleErrors:errors},null,2)+'\n')
    console.log('Independent behavior verification passed')
  } catch(error) {
    console.error(error)
    try{await capture('failure')}catch{}
    fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({error:String(error.stack||error),events,consoleErrors:errors},null,2)+'\n');process.exitCode=1
  }finally{win.destroy();app.exit(process.exitCode||0)}
}).catch(error=>{console.error(error);app.exit(1)})
