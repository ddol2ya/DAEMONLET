import { describe, expect, it } from "vitest"
import "../src/engine/anime25d/upstream/rigger.js"

// Independent small-image reference for component cleanup + a clipped 7x7
// neighborhood. Exercises holes, dust, transparency and all image boundaries.
function reference(input: Uint8Array, w: number, h: number, minimum: number) {
  const kept = new Uint8Array(input.length), visited = new Set<number>()
  let components = 0, accepted = 0
  for (let i=0;i<input.length;i++) {
    if (input[i]<=16 || visited.has(i)) continue
    components++; const pixels:number[] = [], queue=[i]; visited.add(i)
    while(queue.length) {
      const p=queue.pop()!; pixels.push(p)
      const x=p%w,y=Math.floor(p/w)
      for(const n of [x>0?p-1:-1,x<w-1?p+1:-1,y>0?p-w:-1,y<h-1?p+w:-1]) if(n>=0&&input[n]>16&&!visited.has(n)){visited.add(n);queue.push(n)}
    }
    if(pixels.length>=minimum){accepted++;for(const p of pixels)kept[p]=1}
  }
  if(!components||!accepted)return input.slice()
  const output=input.slice()
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    let keep=false
    for(let dy=-3;dy<=3;dy++)for(let dx=-3;dx<=3;dx++)if(x+dx>=0&&x+dx<w&&y+dy>=0&&y+dy<h&&kept[(y+dy)*w+x+dx])keep=true
    if(!keep)output[y*w+x]=0
  }
  return output
}
describe("optimized alpha cleanup",()=>{
  it("matches the reference byte for byte across sparse, dense and small images",()=>{
    const clean=(globalThis.Rigger as unknown as { _internals:{cleanAlpha(a:Uint8Array,w:number,h:number,min:number):Uint8Array} })._internals.cleanAlpha
    let seed=123
    for(const [w,h]of [[1,1],[2,7],[7,2],[9,11],[31,19]])for(const minimum of [0,1,4,40])for(const density of [.05,.5,.95]){
      const input=Uint8Array.from({length:w*h},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32<density?255:seed%17})
      expect(clean(input.slice(),w,h,minimum)).toEqual(reference(input,w,h,minimum))
    }
  })
})
