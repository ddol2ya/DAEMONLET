import {afterEach,expect,it,vi} from 'vitest'
import {RuntimeSupervisor} from '../electron/main/character-chat/RuntimeSupervisor'
import {CHAT_REPLY_SCHEMA} from '../electron/shared/character-chat-semantics'
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks()})
const reply=JSON.stringify({text:'안녕하세요.',emotion:'neutral',intent:'chat',gesture:'none',intensity:.1})
function fixture(events:unknown[]){
 const runtime=new RuntimeSupervisor('/unused'),session={url:'http://127.0.0.1:9999',token:'test-only',abort:new AbortController()}
 vi.spyOn(runtime as any,'requireSession').mockReturnValue(session)
 const calls:Array<{url:string,body:any,signal:AbortSignal}>=[]
 vi.stubGlobal('fetch',vi.fn(async(url:string,options:any)=>{
  calls.push({url,body:JSON.parse(options.body),signal:options.signal})
  if(url.endsWith('/apply-template'))return Response.json({prompt:'official-rendered-prompt'})
  if(url.endsWith('/tokenize'))return Response.json({tokens:[1,2,3]})
  const bytes=new TextEncoder().encode(events.map(e=>'data: '+(typeof e==='string'?e:JSON.stringify(e))+'\n\n').join(''))
  return new Response(new ReadableStream({start(c){for(const b of bytes)c.enqueue(Uint8Array.of(b));c.close()}}))
 }));return {runtime,calls}
}
it('uses the same non-thinking template for counting and strict native JSON generation',async()=>{
 const {runtime,calls}=fixture([{content:reply.slice(0,14),stop:false},{content:reply.slice(14),stop:false},{content:'',stop:true,stop_type:'eos',truncated:false}]);const messages=[{role:'user' as const,content:'안녕'}],seen:string[]=[]
 expect(await runtime.count(messages)).toBe(3);expect((await runtime.generate(messages,t=>seen.push(t))).text).toBe('안녕하세요.')
 expect(calls.filter(c=>c.url.endsWith('/apply-template')).map(c=>c.body)).toEqual([1,2].map(()=>({messages,add_generation_prompt:true,chat_template_kwargs:{enable_thinking:false},reasoning_effort:'none'})))
 const generated=calls.at(-1)!;expect(generated.url).toMatch(/\/completion$/);expect(generated.body).toMatchObject({prompt:'official-rendered-prompt',json_schema:CHAT_REPLY_SCHEMA,n_predict:512,reasoning_budget_tokens:0,stream:true,cache_prompt:true});expect(generated.body).not.toHaveProperty('response_format');expect(seen.at(-1)).toBe('안녕하세요.');expect(generated.signal.aborted).toBe(true)
})
it.each([
 [[{content:reply,stop:false}],'비정상'],
 [[{content:reply,stop:true,stop_type:'limit'}],'길이 제한'],
 [[{content:reply,stop:true,stop_type:'eos',truncated:true}],'잘려'],
 [[{content:'<|channel>thought',stop:false}],'JSON 이외'],
 [[{content:'',stop:false,reasoning_content:'unexpected'}],'비추론'],
 [[{content:reply.replace('안녕하세요.','<think>internal'),stop:false}],'생각 태그'],
 [[{content:reply,stop:true,stop_type:'eos'},{content:'extra',stop:false}],'비정상'],
 [['[DONE]'],'비정상']
] as const)('rejects malformed/limited/reasoning streams and aborts the transport',async(events,error)=>{const {runtime,calls}=fixture([...events]);await expect(runtime.generate([{role:'user',content:'질문'}],()=>{})).rejects.toThrow(error);expect(calls.at(-1)!.signal.aborted).toBe(true)})
