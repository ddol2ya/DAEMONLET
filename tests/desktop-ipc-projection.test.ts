import { describe, expect, it } from "vitest"
import { DesktopIpcProjection } from "../electron/main/control/DesktopIpcProjection"
import { applyDesktopPatches, desktopLiveState, projectDesktopState } from "../electron/main/control/DesktopConversationState"

const id = "01a08ffc-46d8-77f0-92c6-3b15412ed955", turnId = "01a090a0-0000-7000-8000-000000000001"
function project(value: unknown, size = 17) {
  const bytes = Buffer.from(JSON.stringify(value)), stream = new DesktopIpcProjection()
  for (let offset = 0; offset < bytes.length; offset += size) stream.write(bytes.subarray(offset, offset + size))
  return {value:stream.finish(), retained:stream.retainedCharacters}
}
const state = () => ({id,title:"상태🙂",threadRuntimeStatus:{type:"active",activeFlags:[]},requests:[],turns:[{turnId,status:"inProgress",items:[{text:"PRIVATE"}]}]})
const frame = (conversationState: unknown) => ({type:"broadcast",method:"thread-stream-state-changed",version:11,sourceClientId:"owner",targetClientIds:["follower"],params:{hostId:"local",conversationId:id,change:{type:"snapshot",revision:12,conversationState}}})

describe("streaming desktop IPC projection", () => {
  it.each([1,2,17,4096])("preserves status and split Unicode with %i-byte fragments", size => {
    const original = state(), result = project(frame(original), size).value
    expect(result.params.change.conversationState).toEqual(projectDesktopState(original))
    expect(desktopLiveState(result.params.change.conversationState,id)).toMatchObject({type:"active",turn:{id:turnId,status:"inProgress"}})
    expect(JSON.stringify(result)).not.toContain("PRIVATE")
  })
  it("discards a 40MB historical image before assembly and retains only status metadata", () => {
    const stream = new DesktopIpcProjection()
    stream.write(Buffer.from('{"type":"broadcast","params":{"change":{"conversationState":{"items":[{"image":"'))
    const chunk = Buffer.alloc(64*1024,120)
    for (let i=0;i<640;i++) stream.write(chunk)
    const kept = state()
    stream.write(Buffer.from('"}],'+JSON.stringify(kept).slice(1)+'}}}'))
    const value = stream.finish()
    expect(value.params.change.conversationState).toEqual(projectDesktopState(kept))
    expect(stream.retainedCharacters).toBeLessThan(2000)
  })
  it("preserves relevant patch values, positions and removals while dropping tool output", () => {
    const patches = [
      {op:"add",path:["turns",0,"items",0],value:{text:"PRIVATE_PATCH"}},
      {op:"replace",path:["turns",0,"status"],value:"completed"},
      {op:"replace",path:["threadRuntimeStatus"],value:{type:"idle",activeFlags:[],private:"PRIVATE_STATUS"}},
      {op:"remove",path:["requests",0]},
    ]
    const f = frame(state()) as any
    f.params.change = {type:"patches",baseRevision:12,revision:13,patches}
    const result = project(f).value
    expect(result.params.change.patches[1]).toEqual(patches[1])
    expect(result.params.change.patches[0].value).toBeUndefined()
    const original = state(); original.requests = [{method:"approval"}] as any
    const updated = applyDesktopPatches(projectDesktopState(original),result.params.change.patches)
    expect(desktopLiveState(updated,id).type).toBe("idle")
    expect(JSON.stringify(result)).not.toContain("PRIVATE")
  })
  it("retains only supported response fields", () => {
    expect(project({type:"response",requestId:"a",method:"initialize",resultType:"success",handledByClientId:"b",result:{clientId:"b",supportsUntrustedAppInput:true,private:"PRIVATE"}}).value.result).toEqual({clientId:"b",supportsUntrustedAppInput:true})
  })
  it("bounds nesting, selected metadata and keys, and rejects malformed JSON", () => {
    expect(()=>project({type:"x".repeat(5000)})).toThrow("PROTOCOL_METADATA_LIMIT")
    expect(()=>project({["x".repeat(5000)]:true})).toThrow("PROTOCOL_METADATA_LIMIT")
    const nested = new DesktopIpcProjection()
    expect(()=>nested.write(Buffer.from("[".repeat(65)))).toThrow("PROTOCOL_METADATA_LIMIT")
    const malformed = new DesktopIpcProjection(); malformed.write(Buffer.from('{"type":'))
    expect(()=>malformed.finish()).toThrow()
  })
})
