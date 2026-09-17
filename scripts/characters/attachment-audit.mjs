// Production QA only. Points and seam coverage must be measured on each artwork.
const point = p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)
const distance = (a,b) => Math.hypot(a[0]-b[0],a[1]-b[1])

export function validateConnections(connections, movingLayers, layers) {
  if (!Array.isArray(connections)) throw Error('Declare connections for every independently moving layer')
  const names = new Set()
  for (const c of connections) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(c.name ?? '') || names.has(c.name)) throw Error('Connections need distinct safe names')
    names.add(c.name)
    if (!c.layer || !c.parentLayer || c.layer === c.parentLayer) throw Error('Connection needs distinct child and parent layers')
    if (!Array.isArray(c.points) || c.points.length < 3 || c.points.some(p=>!point(p.child)||!point(p.parent))) throw Error('Cover each connection with at least three measured point pairs')
    for (const key of ['child','parent']) if (new Set(c.points.map(p=>p[key].join(','))).size !== c.points.length) throw Error('Connection points must span the boundary, not repeat one root')
    if (!Number.isFinite(c.maxDriftPx) || c.maxDriftPx <= 0) throw Error('Connection needs a positive source-pixel drift tolerance')
    const b=c.reviewBounds
    if (!Array.isArray(b)||b.length!==4||!b.every(Number.isFinite)||b[2]<=0||b[3]<=0) throw Error('Connection needs reviewBounds [x,y,width,height]')
    if (c.points.some(p=>[p.child,p.parent].some(([x,y])=>x<b[0]||y<b[1]||x>b[0]+b[2]||y>b[1]+b[3]))) throw Error('Review crop must contain the complete declared connection')
    if (layers) for (const [key,name] of [['child',c.layer],['parent',c.parentLayer]]) {
      const l=layers.find(l=>l.name===name)
      if (!l) throw Error('Unknown connection layer: '+name)
      if (c.points.some(p=>p[key][0]<l.x||p[key][0]>l.x+l.w||p[key][1]<l.y||p[key][1]>l.y+l.h)) throw Error('Connection point outside actual mesh: '+c.name+'/'+name)
    }
  }
  for (const layer of movingLayers) if (!connections.some(c=>c.layer===layer)) throw Error('Missing attachment boundary for moving layer: '+layer)
}

export function validateLayerReviews(joints) {
  for (const joint of joints) {
    const r=joint.layerReview
    if (r?.status!=='ready' || !Array.isArray(r.remainingFixedParts) || r.remainingFixedParts.length) throw Error('Separate or reconstruct mixed moving/fixed artwork before rigging: '+joint.layer)
    if (!r.movingParts?.length || r.movingParts.some(p=>typeof p!=='string'||!p.trim()) || !r.evidence?.length || r.evidence.some(p=>typeof p!=='string'||!p.trim())) throw Error('Record moving parts and inspected isolated-layer evidence: '+joint.layer)
  }
}

// Match the renderer's two triangles, not bilinear interpolation or extrapolation.
export function sampleMeshPoint(layers, name, p) {
  const l=layers.find(l=>l.name===name)
  if (!l || !point(p) || p[0]<l.x || p[0]>l.x+l.w || p[1]<l.y || p[1]>l.y+l.h) throw Error('Point outside actual mesh: '+name)
  const u=(p[0]-l.x)/l.w*l.nx,v=(p[1]-l.y)/l.h*l.ny
  const ix=Math.min(l.nx-1,Math.floor(u)),iy=Math.min(l.ny-1,Math.floor(v)),x=u-ix,y=v-iy
  const a=iy*(l.nx+1)+ix,b=a+1,c=a+l.nx+1,d=c+1
  const indices=x+y<=1?[a,b,c]:[b,d,c],weights=x+y<=1?[1-x-y,x,y]:[1-y,x+y-1,1-x]
  const result=[0,1].map(k=>indices.reduce((sum,index,i)=>sum+l.current[index*2+k]*weights[i],0))
  if (!result.every(Number.isFinite)) throw Error('Nonfinite attachment vertex: '+name)
  return result
}

export function sampleConnections(layers, connections) {
  return connections.map(c=>({name:c.name,points:c.points.map(p=>({child:sampleMeshPoint(layers,c.layer,p.child),parent:sampleMeshPoint(layers,c.parentLayer,p.parent)}))}))
}

export function auditConnections(connections, frames) {
  if (!frames.length) throw Error('No attachment frames')
  const results=connections.map((c,i)=>{
    let maxDriftPx=0,worstAtMs=0,worstPoint=0
    const first=frames[0].connections[i].points
    for (const frame of frames) for (const [j,p] of frame.connections[i].points.entries()) {
      const initial=first[j],drift=distance([p.child[0]-p.parent[0],p.child[1]-p.parent[1]],[initial.child[0]-initial.parent[0],initial.child[1]-initial.parent[1]])
      if (!Number.isFinite(drift)) throw Error('Nonfinite attachment drift')
      if (drift>maxDriftPx) {maxDriftPx=drift;worstAtMs=frame.atMs;worstPoint=j}
    }
    return {name:c.name,layer:c.layer,parentLayer:c.parentLayer,points:c.points.length,maxDriftPx,tolerancePx:c.maxDriftPx,worstAtMs,worstPoint,pass:maxDriftPx<=c.maxDriftPx,reviewBounds:c.reviewBounds}
  })
  return {pass:results.every(c=>c.pass),frames:frames.length,connections:results}
}

// Include exact keyframe peaks as well as every video frame, including loop closure.
export function motionSampleTimes(motion, fps=30) {
  const duration=motion.loopDurationMs+(motion.playback==='once'?1000:0)
  const times=new Set(Array.from({length:Math.ceil(duration*fps/1000)+1},(_,i)=>Math.min(duration,i*1000/fps)))
  const visit=v=>{if(!v||typeof v!=='object')return;if(v.type==='keyframes')for(const f of v.frames)times.add(f.atMs);else for(const value of Object.values(v))visit(value)}
  visit(motion)
  return [...times].sort((a,b)=>a-b)
}
