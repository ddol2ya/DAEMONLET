import {expect,it} from 'vitest'
import {auditConnections,motionSampleTimes,sampleMeshPoint,validateConnections,validateLayerReviews} from '../scripts/characters/attachment-audit.mjs'
const connection={name:'shoulder',layer:'arm',parentLayer:'torso',points:[0,5,10].map(x=>({child:[x,0],parent:[x,2]})),maxDriftPx:1,reviewBounds:[-2,-2,14,8]}
it('rejects a separating shoulder even when the first root stays fixed and the hand travels',()=>{
 const neutral={atMs:0,connections:[{points:connection.points}]}
 const peak={atMs:1061,connections:[{points:connection.points.map((p,i)=>({child:[p.child[0]+10,p.child[1]+(i===2?-18:0)],parent:[p.parent[0]+10,p.parent[1]]}))}]}
 const report=auditConnections([connection],[neutral,peak])
 expect(report.pass).toBe(false);expect(report.connections[0]).toMatchObject({maxDriftPx:18,worstPoint:2,worstAtMs:1061})
 const safe={...peak,connections:[{points:connection.points.map(p=>({child:[p.child[0]+10,p.child[1]],parent:[p.parent[0]+10,p.parent[1]]}))}]}
 expect(auditConnections([connection],[neutral,safe]).pass).toBe(true)
})
it('requires complete moving-layer coverage and refuses duplicated or out-of-mesh roots',()=>{
 expect(()=>validateConnections([connection],['arm','other-arm'])).toThrow('Missing attachment')
 expect(()=>validateConnections([{...connection,points:Array(3).fill(connection.points[0])}],['arm'])).toThrow('span')
 expect(()=>validateConnections([connection],['arm'],[{name:'arm',x:0,y:0,w:5,h:5},{name:'torso',x:0,y:0,w:10,h:10}])).toThrow('outside actual mesh')
})
it('blocks unresolved mixed-content layers and requires inspected layer evidence',()=>{
 const layerReview={status:'ready',movingParts:['forearm'],remainingFixedParts:[],evidence:['qa/forearm.png']}
 expect(()=>validateLayerReviews([{layer:'arm',layerReview}])).not.toThrow()
 expect(()=>validateLayerReviews([{layer:'arm',layerReview:{...layerReview,remainingFixedParts:['torso','hair']}}])).toThrow('Separate or reconstruct')
 expect(()=>validateLayerReviews([{layer:'arm'}])).toThrow('Separate or reconstruct')
 expect(()=>validateLayerReviews([{layer:'arm',layerReview:{...layerReview,evidence:[]}}])).toThrow('evidence')
})
it('samples the actual rendered triangles and refuses extrapolated coordinates',()=>{
 const mesh={name:'arm',x:0,y:0,w:1,h:1,nx:1,ny:1,current:[0,0,1,0,0,1,2,2]}
 expect(sampleMeshPoint([mesh],'arm',[.25,.25])).toEqual([.25,.25])
 expect(sampleMeshPoint([mesh],'arm',[.75,.75])).toEqual([1.25,1.25])
 expect(()=>sampleMeshPoint([mesh],'arm',[2,.5])).toThrow('outside actual mesh')
})
it('includes short peaks between video frames, the cycle end and a once-only settling tail',()=>{
 const motion={loopDurationMs:1000,playback:'loop',layers:{arm:{translateY:{type:'keyframes',frames:[{atMs:0,value:0},{atMs:421,value:24},{atMs:429,value:0}]}}}}
 const times=motionSampleTimes(motion)
 expect(times).toContain(421);expect(times).toContain(429);expect(times).toContain(1000)
 expect(times.length).toBe(33)
 expect(motionSampleTimes({...motion,playback:'once'}).at(-1)).toBe(2000)
})
