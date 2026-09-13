// PSD export with the same semantic order constraints used by the runtime.
// The editor PSD shows the neutral expression. The runtime inventory retains
// every expression texture because PsdRigLoader deliberately skips hidden layers.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {readRgba,writeRgba} from './png-rgba.mjs'
import {initializeCanvas,writePsd,readPsd} from 'ag-psd'
const dir=fs.realpathSync(process.argv[2]),allowed=fs.realpathSync('outputs/characters')
if(!dir.startsWith(allowed+path.sep))throw Error('Export escaped experiment')
const meta=JSON.parse(fs.readFileSync(path.join(dir,'layers.json'))),overrides=JSON.parse(fs.readFileSync(path.join(dir,'rig-overrides.json')))
initializeCanvas(()=>{throw Error('No canvas')},(width,height)=>({width,height,data:new Uint8ClampedArray(width*height*4),colorSpace:'srgb'}))
const norm=n=>n.normalize('NFKC').trim().toLowerCase(),stem=n=>norm(n).replace(/[-_]([lr])$/,'').replace(/_\d+$/,'')
const canonical=n=>norm(n).replace(/^(handwear|ears)[-_]([lr])$/,(_,s,p)=>s+'_'+(p==='l'?1:2)).replace(/^(eyewhite|irides|eyelash|eyebrow|eye_close)[-_]([lr])$/,'$1_$2')
const rank=new Map((overrides.layerOrder||[]).map((n,i)=>[norm(n),i]))
let rows=meta.layers.map((row,original)=>({row,original,rank:rank.get(norm(row.name))??rank.get(stem(row.name))??rank.get(canonical(row.name))})).sort((a,b)=>(a.rank??1e5)-(b.rank??1e5)||a.original-b.original).map(x=>x.row)
const matches=(n,s)=>canonical(n)===canonical(s)||stem(canonical(n))===canonical(s)
const edges=rows.map(()=>new Set()),indeg=rows.map(()=>0),rules=[]
for(const rule of overrides.layerOrderConstraints||[]){
 const from=rows.flatMap((x,i)=>matches(x.name,rule.behind)?[i]:[]),to=rows.flatMap((x,i)=>matches(x.name,rule.inFrontOf)?[i]:[])
 if(!from.length||!to.length)throw Error('Unresolved PSD priority rule '+JSON.stringify(rule))
 for(const a of from)for(const b of to){if(a!==b&&!edges[a].has(b)){edges[a].add(b);indeg[b]++}}
 rules.push({...rule,resolvedBehind:from.map(i=>rows[i].name),resolvedInFront:to.map(i=>rows[i].name)})
}
const ready=rows.flatMap((_,i)=>indeg[i]===0?[i]:[]),order=[]
while(ready.length){ready.sort((a,b)=>a-b);const i=ready.shift();order.push(i);for(const j of edges[i])if(--indeg[j]===0)ready.push(j)}
if(order.length!==rows.length)throw Error('Cyclic PSD priority rules')
rows=order.map(i=>rows[i]);const extraHidden=new Set(rows.filter(row=>row.editorHidden).map(row=>row.name));const hidden=n=>extraHidden.has(n)||/^eye_close[-_]/.test(n)||['mouth_open','mouth_smile'].includes(n)
const composite=new Uint8ClampedArray(meta.width*meta.height*4)
function sourceOver(src,w,h,left,top){for(let y=0;y<h;y++)for(let x=0;x<w;x++){const xx=left+x,yy=top+y;if(xx<0||yy<0||xx>=meta.width||yy>=meta.height)continue;const s=(y*w+x)*4,d=(yy*meta.width+xx)*4,sa=src[s+3]/255,da=composite[d+3]/255,a=sa+da*(1-sa);if(a<=0)continue;for(let c=0;c<3;c++)composite[d+c]=Math.round((src[s+c]*sa+composite[d+c]*da*(1-sa))/a);composite[d+3]=Math.round(a*255)}}
const maskCache=new Map()
const layers=rows.map((row,rowIndex)=>{
 const file=path.resolve(dir,row.filename);if(!file.startsWith(dir+path.sep))throw Error('Part path escaped')
 const width=row.right-row.left,height=row.bottom-row.top,data=readRgba(file)
 if(data.length!==width*height*4)throw Error('Bad part dimensions')
 let preview=data
 if(row.clipTo){
  if(rowIndex===0||rows[rowIndex-1].name!==row.clipTo)throw Error('Photoshop clipping base must be adjacent: '+row.name)
  const mask=maskCache.get(row.clipTo);if(!mask)throw Error('Missing clipping base '+row.clipTo);preview=Buffer.from(data)
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){const mx=row.left+x-mask.left,my=row.top+y-mask.top,alpha=mx>=0&&my>=0&&mx<mask.width&&my<mask.height?mask.data[(my*mask.width+mx)*4+3]:0;preview[(y*width+x)*4+3]=Math.round(preview[(y*width+x)*4+3]*alpha/255)}
 }
 maskCache.set(row.name,{left:row.left,top:row.top,width,height,data})
 if(!hidden(row.name))sourceOver(preview,width,height,row.left,row.top)
 return {...row,clipping:!!row.clipTo,opacity:1,blendMode:'normal',imageData:{width,height,data:new Uint8ClampedArray(data)},hidden:false}
})
const hash=b=>crypto.createHash('sha256').update(b).digest('hex'),records=[]
for(const [filename,editor] of [['model.psd',false],['model-authoring.psd',true]]){
 const children=layers.map(l=>({...l,hidden:editor&&hidden(l.name)})),data=Buffer.from(writePsd({width:meta.width,height:meta.height,imageData:{width:meta.width,height:meta.height,data:composite},children}))
 fs.writeFileSync(path.join(dir,filename),data);const decoded=readPsd(data,{useImageData:true,skipThumbnail:true})
 if(decoded.children.length!==children.length)throw Error('PSD layer loss')
 for(let i=0;i<children.length;i++){const a=children[i],b=decoded.children[i];if(a.name!==b.name||!!a.hidden!==!!b.hidden||!!a.clipping!==!!b.clipping||hash(a.imageData.data)!==hash(b.imageData.data))throw Error('PSD layer round-trip mismatch '+a.name)}
 records.push({file:filename,sha256:hash(data),layers:children.length,hidden:children.filter(x=>x.hidden).map(x=>x.name),clipped:children.filter(x=>x.clipping).map(x=>({name:x.name,clipTo:x.clipTo})),PNG_roundtrip_exact:true,neutral_preview_sha256:hash(decoded.imageData.data)})
}
writeRgba(path.join(dir,'neutral-authored.png'),meta.width,meta.height,composite)
fs.writeFileSync(path.join(dir,'PSD-order-audit.json'),JSON.stringify({bottom_to_top:rows.map(x=>x.name),rules,exports:records,neutral_hidden_expression_layers:rows.filter(x=>hidden(x.name)).map(x=>x.name),reason:'Runtime importer excludes hidden PSD layers, so the neutral-visible editor PSD is separate from its complete expression inventory.'},null,2))
console.log(JSON.stringify({dir,layers:layers.length,priorityRules:rules.length,files:records.map(x=>x.file)}))
