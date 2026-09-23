import {resolve} from 'node:path'
import {runtimeTarget,verifyRuntime} from '../electron/main/character-chat/runtime-artifacts.mjs'
if(!process.argv[2])throw Error('Usage: node scripts/check-chat-runtime.mjs <resources/local-llm> [platform-arch]')
const target=process.argv[3] || runtimeTarget()
const entry=await verifyRuntime(resolve(process.argv[2]),target)
console.log(JSON.stringify({target,commit:entry.commit,backend:entry.backend,filesVerified:Object.keys(entry.files).length,bytesVerified:Object.values(entry.files).reduce((sum,file)=>sum+file.bytes,0)},null,2))
