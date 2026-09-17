import {copyFile,readFile,writeFile} from 'node:fs/promises'
import {resolve,dirname,join} from 'node:path'
const escape = s => String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
export async function writeReviewGallery(root, output, reports) {
  const index=JSON.parse(await readFile(join(root,'models.json'),'utf8')),sections=[]
  for(const report of reports){
    const model=index.models.find(m=>m.id===report.pose),file=resolve(root,model.model),config=JSON.parse(await readFile(file,'utf8'))
    await copyFile(resolve(dirname(file),config.bodySource),join(output,report.pose,'source.png'))
    const picture=(name,box)=>`<figure><figcaption>${escape(name)}</figcaption><svg viewBox="${box.join(' ')}"><image href="${escape(report.pose)}/${name}.png" width="1280" height="1280"/></svg></figure>`
    const a=report.diagnostic.anchors
    const regions=[['eyeL',a.eyeL],['eyeR',a.eyeR],['mouth',a.mouth]].map(([name,p])=>{
      const cx=p.icx??p.cx,cy=p.icy??p.cy
      const w=Math.max(100,(p.x1-p.x0)*2),h=Math.max(90,(p.y1-p.y0)*3)
      return {name,box:[cx-w/2,cy-h*.65,w,h]}
    })
    const rows=regions.map(({name,box})=>`<h3>${name}</h3><div class="strip">${picture('source',box)}${picture('neutral',box)}${Array.from({length:11},(_,i)=>picture(`${name==='mouth'?'mouth':'blink'}-${i}`,box)).join('')}</div>${name==='mouth'?`<div class="strip">${Array.from({length:11},(_,i)=>picture(`smile-${i}`,box)).join('')}</div>`:''}`).join('')
    const joints=(report.attachments?.connections??[]).map(c=>{
      const frames=report.attachmentFrames.filter(f=>f.name===c.name),worst=frames.reduce((a,f,i)=>Math.abs(f.atMs-c.worstAtMs)<Math.abs(frames[a].atMs-c.worstAtMs)?i:a,0)
      return `<h3>${escape(c.name)} — ${c.pass?'numeric check passed; inspect visually':'FAILED'} (${c.maxDriftPx.toFixed(2)} / ${c.tolerancePx}px)</h3><p>${c.points} boundary points; worst at ${c.worstAtMs.toFixed(1)}ms. Inspect every frame and both backgrounds. Holes, doubled outlines or wrong layer content still fail even when drift is small.</p><div class="attachment" data-frames="${escape(JSON.stringify(frames.map(f=>({file:report.pose+'/'+f.file,atMs:f.atMs}))))}"><img style="width:${c.reviewBounds[2]*2}px" src="${escape(report.pose+'/'+frames[worst].file)}"><br><button type="button">Play / pause</button> <input type="range" min="0" max="${frames.length-1}" value="${worst}"><output>${c.worstAtMs.toFixed(1)}ms</output></div>`
    }).join('')
    sections.push(`<section><h2>${escape(report.pose)}</h2><p>Source fingerprint: ${report.sourceFingerprint}. Captured; visual review pending.</p><div class="full">${picture('source',[0,0,1280,1280])}${picture('neutral',[0,0,1280,1280])}${picture('combined',[0,0,1280,1280])}</div>${rows}${joints}${report.motionFrames?`<video controls loop src="${escape(report.pose)}/motion-1280.mp4"></video>`:''}</section>`)
  }
  await writeFile(join(output,'review.html'),`<!doctype html><meta charset="utf-8"><title>Character visual review</title><style>body{font:14px system-ui;margin:20px;background:#ddd;color:#222}header{position:sticky;top:0;background:#ddd;padding:12px;z-index:1}.strip,.full{display:flex;gap:8px;overflow:auto}figure{margin:0;flex-shrink:0}svg{width:180px;height:160px;background:var(--bg,#fff)}.attachment img{background:var(--bg,#fff);max-width:100%;height:auto}.attachment input{width:60%}.full svg,video{width:var(--size,320px);height:var(--size,320px)}section{margin:35px 0}figcaption{padding:6px}</style><header>Inspect source identity, both eyes/brows, half blink, lips, skin patches, attachment seams and outer outlines. Technical success is not visual acceptance.<br>Background <select id="bg"><option value="#fff">White</option><option value="#252a33">Dark</option></select> Full view <select id="size"><option>320</option><option>460</option><option>1280</option></select></header>${sections.join('')}<script>document.querySelector('#bg').onchange=e=>document.body.style.setProperty('--bg',e.target.value);document.querySelector('#size').onchange=e=>document.body.style.setProperty('--size',e.target.value+'px');for(const el of document.querySelectorAll('.attachment')){const frames=JSON.parse(el.dataset.frames),slider=el.querySelector('input'),img=el.querySelector('img'),out=el.querySelector('output');let timer;const show=()=>{const f=frames[+slider.value];img.src=f.file;out.textContent=f.atMs.toFixed(1)+'ms'};slider.oninput=show;el.querySelector('button').onclick=()=>{if(timer){clearInterval(timer);timer=null}else timer=setInterval(()=>{slider.value=(+slider.value+1)%frames.length;show()},1000/30)}}</script>`)
}
