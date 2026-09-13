import {execFileSync} from 'node:child_process'
import {join} from 'node:path'
const python=()=>process.env.DAEMONLET_CREATOR_PYTHON || (process.platform==='win32'?'python':'python3')
const script=join(import.meta.dirname,'png-rgba.py')
export const readRgba=file=>execFileSync(python(),[script,'read',file],{maxBuffer:256*1024*1024})
export const writeRgba=(file,width,height,data)=>execFileSync(python(),[script,'write',file,String(width),String(height)],{input:Buffer.from(data),maxBuffer:1024*1024})
