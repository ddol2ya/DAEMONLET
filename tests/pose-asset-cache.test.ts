import { afterEach, describe, expect, it, vi } from "vitest"
import { PoseAssetLoader } from "../src/pose/PoseAssetLoader"
import { PsdRigLoader } from "../src/engine/anime25d/PsdRigLoader"
import type { RigDefinition, RigLoadResult } from "../src/engine/anime25d/types"
import type { PoseManifest } from "../src/pose/types"

const rig: RigDefinition = {
  canvas:{w:100,h:100}, warnings:[], synth:{eye:false,mouth:false},
  layers:[{name:"handwear_1",group:"body",x:20,y:40,w:1,h:1,z:0,depth:1,phys:null,fade:null,side:null,strands:null,img:{width:1,height:1,data:new Uint8ClampedArray([255,255,255,255])}}],
  anchors:{face:{x0:20,y0:10,x1:80,y1:50,cx:50,cy:30},eyeL:{x0:28,y0:25,x1:34,y1:31,icx:31,icy:28,closeY:30},eyeR:{x0:66,y0:25,x1:72,y1:31,icx:69,icy:28,closeY:30},mouth:{x0:46,y0:40,x1:54,y1:44,cx:50,cy:42},neckPivot:{cx:50,cy:58},bodyPivot:{cx:50,cy:95},neckTop:50,neckBottom:60,hairRootY:0,faceScale:1},
}
const manifest=(id:string):PoseManifest=>({schemaVersion:1,id,label:id,source:"source.png",psd:"pose.psd",strategy:"semantic-layer-swap",registration:{strategy:"eyes-and-neck",maxScaleDelta:.06,maxRotationDeg:3,maxAnchorErrorPx:15},layers:{sharedFromBase:[],replaceFromBase:["handwear_1"],useFromPose:["handwear_1"],addFromPose:[]},transition:{enterMs:200,exitMs:200,swapStart:.4,swapEnd:.6}})
const setup=()=>{
  const psd=new PsdRigLoader()
  const decode=vi.spyOn(psd,"loadArrayBuffer").mockReturnValue({model:{rig}} as RigLoadResult)
  const fetch=vi.fn(async()=>new Response(new Uint8Array([1])))
  vi.stubGlobal("fetch",fetch)
  return {loader:new PoseAssetLoader(psd),decode,fetch}
}
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks()})

describe("prepared pose asset cache",()=>{
  it("reuses parsed assets only for the same Base and manifest",async()=>{
    const {loader,decode,fetch}=setup(),definition=manifest("tap")
    const first=await loader.load("http://localhost/tap/pose.json",rig,{manifest:definition})
    expect(await loader.load("http://localhost/tap/pose.json",rig,{manifest:definition})).toBe(first)
    expect(decode).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledTimes(1)
    await loader.load("http://localhost/tap/pose.json",structuredClone(rig),{manifest:definition})
    expect(decode).toHaveBeenCalledTimes(2)
    expect(loader.cachedAssetCount).toBe(1)
    loader.clear()
    expect(loader.cachedAssetCount).toBe(0)
  })

  it("bounds memory and evicts the least recently used pose",async()=>{
    const {loader,decode}=setup()
    for(let i=0;i<17;i++)await loader.load(`http://localhost/${i}/pose.json`,rig,{manifest:manifest(String(i))})
    expect(loader.cachedAssetCount).toBe(16)
    await loader.load("http://localhost/16/pose.json",rig,{manifest:manifest("16")})
    expect(decode).toHaveBeenCalledTimes(17)
    await loader.load("http://localhost/0/pose.json",rig,{manifest:manifest("0")})
    expect(decode).toHaveBeenCalledTimes(18)
    expect(loader.cachedAssetCount).toBe(16)
  })

  it("does not cache a failed parse and honors aborts even on a cache hit",async()=>{
    const {loader,decode}=setup(),definition=manifest("tap"),url="http://localhost/tap/pose.json"
    decode.mockImplementationOnce(()=>{throw new Error("broken PSD")})
    await expect(loader.load(url,rig,{manifest:definition})).rejects.toThrow("broken PSD")
    expect(loader.cachedAssetCount).toBe(0)
    await loader.load(url,rig,{manifest:definition})
    const controller=new AbortController();controller.abort()
    await expect(loader.load(url,rig,{manifest:definition,signal:controller.signal})).rejects.toMatchObject({name:"AbortError"})
    expect(decode).toHaveBeenCalledTimes(2)
  })

  it("evicts by decoded bytes before the entry limit and does not retain an oversized pose",async()=>{
    const {loader,decode}=setup()
    const large={...rig,layers:[{...rig.layers[0],img:{...rig.layers[0].img,data:new Uint8ClampedArray(24*1024*1024)}}]}
    decode.mockReturnValue({model:{rig:large}} as RigLoadResult)
    for(let i=0;i<3;i++)await loader.load(`http://localhost/large-${i}/pose.json`,rig,{manifest:manifest(String(i))})
    expect(loader.cachedAssetCount).toBe(2)
    loader.clear()
    decode.mockReturnValue({model:{rig:{...large,layers:[{...large.layers[0],img:{...large.layers[0].img,data:new Uint8ClampedArray(80*1024*1024)}}]}}} as RigLoadResult)
    await loader.load("http://localhost/oversized/pose.json",rig,{manifest:manifest("oversized")})
    expect(loader.cachedAssetCount).toBe(0)
  })
})
