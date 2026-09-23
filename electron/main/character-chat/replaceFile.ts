import {rename} from 'node:fs/promises'
import {setTimeout as delay} from 'node:timers/promises'

/** Never pre-delete the destination: a failed replacement preserves original bytes. */
export async function replaceFile(source:string,destination:string,signal?:AbortSignal,platform=process.platform) {
 for(let attempt=0;;attempt++) {
  signal?.throwIfAborted()
  try {await rename(source,destination);return}
  catch(error) {
   if(platform!=='win32' || !['EPERM','EACCES','EBUSY'].includes((error as NodeJS.ErrnoException).code || '') || attempt>=5)throw error
   await delay(50*(attempt+1),undefined,{signal})
  }
 }
}
