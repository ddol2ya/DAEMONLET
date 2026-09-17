const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process')
const output=process.env.SOURCE_QA_OUTPUT,root=process.env.SOURCE_QA_ROOT,q=JSON.stringify
app.setPath('userData',path.join(output,'profile'))
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1300,height:1300,webPreferences:{contextIsolation:true,sandbox:true,backgroundThrottling:false}})
 const run=code=>win.webContents.executeJavaScript(`(async()=>{${code}})()`,true),reports=[],auditFailures=[]
 try{
  await win.loadURL(process.env.SOURCE_QA_URL+'/source-model-capture')
  await run(`const [{Anime25DRenderer},{PsdRigLoader},{DEFAULT_PARAMETERS},{samplePoseMotion},{HitAreaResolver},{PoseAssetLoader}]=await Promise.all([import('/src/engine/anime25d/Anime25DRenderer.ts'),import('/src/engine/anime25d/PsdRigLoader.ts'),import('/src/engine/anime25d/Anime25DParameters.ts'),import('/src/pose/PoseMotion.ts'),import('/src/interaction/HitAreaResolver.ts'),import('/src/pose/PoseAssetLoader.ts')]);window.qa={Anime25DRenderer,PsdRigLoader,DEFAULT_PARAMETERS,samplePoseMotion,HitAreaResolver,PoseAssetLoader};`)
  const models=JSON.parse(fs.readFileSync(path.join(root,'models.json'))).models
  const cases=[{id:'neutral',p:{}},...['blink','mouth','smile'].flatMap(kind=>Array.from({length:11},(_,i)=>({id:`${kind}-${i}`,p:kind==='blink'?{eyeOpenL:i/10,eyeOpenR:i/10}:kind==='mouth'?{mouthOpen:i/10}:{mouthForm:i/10}}))),...['angleX','angleY','angleZ','eyeX','eyeY'].flatMap(k=>[-1,1].map(v=>({id:`${k}-${v<0?'minus':'plus'}`,p:{[k]:v}}))),{id:'combined',p:{angleX:.8,angleY:-.6,angleZ:.7,mouthOpen:.5,mouthForm:.4,eyeOpenL:.5,eyeOpenR:.5}},{id:'return-neutral',p:{}}]
  for(const model of models){
   if(process.env.SOURCE_QA_POSE&&process.env.SOURCE_QA_POSE!==model.id)continue
   const failureStart=auditFailures.length
   const dir=path.join(output,model.id);fs.mkdirSync(dir,{recursive:true})
   const configUrl=process.env.SOURCE_QA_PATH+'/'+model.model
   const diagnostic=await run(`const z=qa,configUrl=${q(configUrl)},config=await(await fetch(configUrl)).json(),relative=p=>new URL(p,new URL(configUrl,location.href)).href,overrides=await(await fetch(relative(config.overrides))).json(),result=new z.PsdRigLoader().loadArrayBuffer(await(await fetch(relative(config.psd))).arrayBuffer(),${q(model.id)},overrides);if(result.model.missingRequiredLayers.length)throw Error('Missing required parts');if(result.model.rig.synth.eye||result.model.rig.synth.mouth)throw Error('Generic feature fallback is not allowed');const omit=new Set(config.excludeAfterMeshResolution??[]);result.model.rig.layers=result.model.rig.layers.filter(l=>!omit.has(l.name));const asset=await new z.PoseAssetLoader().load(relative(config.pose),result.model.rig);if(asset.selection.errors.length||!asset.selection.independentModel||asset.selection.baseShared.length||!asset.registration.accepted)throw Error('Own model selection failed');z.canvas=document.createElement('canvas');document.body.append(z.canvas);z.renderer=new z.Anime25DRenderer(z.canvas);z.renderer.applyRig(result.model.rig);z.renderer.applyPoseRig(asset.result.model.rig,asset.selection,asset.registration.transform);z.renderer.setPoseMix(1);z.renderer.setHairTestMode('off');z.pose=asset.manifest;z.rig=asset.result.model.rig;return {anchors:z.rig.anchors,layers:z.rig.layers.map(l=>({name:l.name,x:l.x,y:l.y,w:l.w,h:l.h,group:l.group,depth:l.depth})),inputAreas:new z.HitAreaResolver(z.rig).areas,vertices:z.renderer.poseLayers.reduce((n,l)=>n+l.base.length/2,0),warnings:z.rig.warnings,synthetic:z.rig.synth,selection:asset.selection};`)
   const records=[]
   for(const definition of cases){
    const test={...definition}
    const png=await run(`const z=qa;z.renderer.setPoseLayerTransforms({});z.renderer.render({...z.DEFAULT_PARAMETERS,...${q(test.p)}},100000,true);if([...z.renderer.layers,...z.renderer.poseLayers].some(l=>l.current.some(v=>!Number.isFinite(v))))throw Error('Nonfinite vertex');if(z.renderer.gl.getError()!==z.renderer.gl.NO_ERROR)throw Error('WebGL error');return z.canvas.toDataURL('image/png')`)
    fs.writeFileSync(path.join(dir,test.id+'.png'),Buffer.from(png.split(',')[1],'base64'))
    if(/^blink-[3-7]$/.test(test.id)){
     test.meshAudit=await run(`const {auditEyeMeshes}=await import('/scripts/characters/mesh-audit.mjs');return auditEyeMeshes(qa.renderer.poseLayers)`)
     if(!test.meshAudit.triangles||test.meshAudit.folds)throw Error('Missing or folded eye mesh: '+model.id+'/'+test.id)
    }
    records.push(test)
   }
   let motionFrames=0,attachments=null,attachmentFrames=[]
   const warmMotion=()=>run(`const z=qa;z.renderer.setHairTestMode('combined');z.renderer.resetSprings();z.renderer.setPoseLayerTransforms({});for(let i=0;i<=60;i++)z.renderer.render(z.DEFAULT_PARAMETERS,198000+i*1000/30,false);`)
   if(process.env.SOURCE_QA_CONTACTS==='1'){
    const authored=JSON.parse(fs.readFileSync(path.join(root,path.dirname(model.model),'motion-authorship.json')))
    const {validateConnections,validateLayerReviews,auditConnections,motionSampleTimes}=await import('./attachment-audit.mjs')
    const movingLayers=await run('return Object.keys(qa.pose.motion.layers??{})')
    let coverageValid=true
    try{validateConnections(authored.connections??[],movingLayers,diagnostic.layers)}catch(e){coverageValid=false;auditFailures.push(model.id+': '+e.message)}
    try{validateLayerReviews(movingLayers.map(layer=>({...authored.joints?.find(j=>j.layer===layer),layer})))}catch(e){auditFailures.push(model.id+': '+e.message)}
    const connections=coverageValid?(authored.connections??[]):[]
    const motion=await run('return qa.pose.motion'),metrics={frames:[],onceHolds:await run("return qa.pose.motion.playback!=='once'||JSON.stringify(qa.samplePoseMotion(qa.pose.motion,qa.pose.motion.loopDurationMs))===JSON.stringify(qa.samplePoseMotion(qa.pose.motion,qa.pose.motion.loopDurationMs+2000))")}
    await warmMotion()
    for(const [index,t] of motionSampleTimes(motion).entries()){
     // Measure and capture the same rendered frame with runtime secondary physics on.
     const frame=await run(`const z=qa,auth=${q(authored)},connections=${q(connections)},s=z.samplePoseMotion(z.pose.motion,${t});const {sampleMeshPoint:sample,sampleConnections}=await import('/scripts/characters/attachment-audit.mjs');z.renderer.setPoseLayerTransforms(s.layers);z.renderer.render({...z.DEFAULT_PARAMETERS,...s.parameters},200000+${t},false);const points=(auth.landmarks??[]).map(m=>({name:m.name,tip:sample(z.renderer.poseLayers,m.layer,m.tip),root:sample(z.renderer.poseLayers,m.layer,m.root),head:m.targetLayer?sample(z.renderer.poseLayers,m.targetLayer,m.targetPoint??m.tip):null}));const crops=connections.map(c=>{const [x,y,w,h]=c.reviewBounds,canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;canvas.getContext('2d').drawImage(z.canvas,x,y,w,h,0,0,w,h);return {name:c.name,png:canvas.toDataURL('image/png')}});return {atMs:${t},points,connections:sampleConnections(z.renderer.poseLayers,connections),crops}`)
     for(const crop of frame.crops){const file=`attachment-${crop.name}-${String(index).padStart(3,'0')}.png`;fs.writeFileSync(path.join(dir,file),Buffer.from(crop.png.split(',')[1],'base64'));attachmentFrames.push({name:crop.name,atMs:t,file})}
     delete frame.crops;metrics.frames.push(frame)
    }
    attachments={...auditConnections(connections,metrics.frames),coverageValid}
    if(!coverageValid||!attachments.pass)auditFailures.push(model.id+': Attachment audit failed')
    const distance=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]),contact=metrics.frames.flatMap(f=>f.points.filter(p=>p.head).map(p=>distance(p.tip,p.head))),maxContact=contact.length?Math.max(...contact):null
    const traces=(authored.landmarks??[]).map((m,i)=>{const travel=Math.max(...metrics.frames.map(f=>distance(f.points[i].tip,metrics.frames[0].points[i].tip)));return {name:m.name,maxTipTravelPx:travel,travelAt320px:travel/4,travelAt460px:travel*460/1280,maxRootTravelPx:Math.max(...metrics.frames.map(f=>distance(f.points[i].root,metrics.frames[0].points[i].root)))}})
    const summary={pose:model.id,frames:metrics.frames.length,onceHolds:metrics.onceHolds,maxHandHeadFieldDifferencePx:maxContact,traces,attachments}
    fs.writeFileSync(path.join(dir,'contacts.json'),JSON.stringify({...summary,frames:metrics.frames},null,2));console.log(JSON.stringify(summary))
    if(!metrics.onceHolds||maxContact!==null&&maxContact>2)auditFailures.push(model.id+': Contact or once-hold audit requires correction')
    for(const [i,landmark] of (authored.landmarks??[]).entries())if(landmark.minTravelAt320px!==undefined){
     if(!Number.isFinite(landmark.minTravelAt320px)||landmark.minTravelAt320px<0)throw Error('Invalid motion visibility target')
     if(traces[i].travelAt320px<landmark.minTravelAt320px)auditFailures.push(model.id+': Motion below authored display-size target: '+landmark.name)
    }
   }
   if(process.env.SOURCE_QA_MOTION==='1'){
    await warmMotion()
    const motion=JSON.parse(fs.readFileSync(path.join(root,path.dirname(model.model),'pose.json'))).motion
    const duration=motion.playback==='once'?Math.max(2800,motion.loopDurationMs+1000):motion.loopDurationMs;motionFrames=Math.ceil(duration*30/1000)
    const ff=spawn('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','image2pipe','-framerate','30','-i','pipe:0','-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p',path.join(dir,'motion-1280.mp4')],{stdio:['pipe','ignore','pipe']});let errors='';ff.stderr.on('data',b=>errors+=b)
    for(let frame=0;frame<motionFrames;frame++){
     const png=await run(`const z=qa,s=z.samplePoseMotion(z.pose.motion,${frame}*1000/30);z.renderer.setPoseLayerTransforms(s.layers);z.renderer.render({...z.DEFAULT_PARAMETERS,...s.parameters},200000+${frame}*1000/30,false);const c=document.createElement('canvas');c.width=c.height=1280;const ctx=c.getContext('2d');ctx.fillStyle='#e4eaf4';ctx.fillRect(0,0,1280,1280);ctx.drawImage(z.canvas,0,0);return c.toDataURL('image/png')`)
     const data=Buffer.from(png.split(',')[1],'base64');if(!ff.stdin.write(data))await new Promise(r=>ff.stdin.once('drain',r));if(frame%30===0||frame===motionFrames-1)fs.writeFileSync(path.join(dir,`motion-${String(frame).padStart(3,'0')}.png`),data)
    }
    ff.stdin.end();if(await new Promise(r=>ff.once('close',r))!==0)throw Error(errors)
   }
   const resources=await run('qa.renderer.unload();qa.canvas.remove();return {meshes:qa.renderer.meshCount,textures:qa.renderer.textureCount,buffers:qa.renderer.bufferCount,framebuffers:qa.renderer.framebufferCount,renderbuffers:qa.renderer.renderbufferCount}')
   if(Object.values(resources).some(Boolean))throw Error('GPU resources retained')
   const snapshot=JSON.parse(fs.readFileSync(path.join(output,'source-snapshot.json')));const report={pose:model.id,sourceFingerprint:snapshot.poses[model.id].fingerprint,diagnostic,cases:records,motionFrames,motionPhysics:'combined',attachments,attachmentFrames,motionAuditPassed:process.env.SOURCE_QA_CONTACTS==='1'&&auditFailures.length===failureStart,motionAuditErrors:auditFailures.slice(failureStart),resourcesAfterUnload:resources};fs.writeFileSync(path.join(dir,'capture.json'),JSON.stringify(report,null,2));reports.push(report);console.log(JSON.stringify({pose:model.id,staticFrames:records.length,motionFrames,vertices:diagnostic.vertices}))
  }
  const {writeReviewGallery}=await import('./review-gallery.mjs');await writeReviewGallery(root,output,reports);
  if(auditFailures.length){fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({errors:auditFailures},null,2));process.exitCode=1}
  fs.writeFileSync(path.join(output,'capture.json'),JSON.stringify({status:auditFailures.length?'failed_motion_audit':'captured_pending_visual_review',poses:reports.map(r=>({pose:r.pose,staticFrames:r.cases.length,motionFrames:r.motionFrames}))},null,2))
 }catch(error){fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({error:String(error.stack||error)},null,2));console.error(error);process.exitCode=1}finally{win.destroy();app.exit(process.exitCode||0)}
}).catch(e=>{console.error(e);app.exit(1)})
