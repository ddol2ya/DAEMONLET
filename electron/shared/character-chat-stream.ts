/** Decode only a top-level JSON text string; incomplete escapes never reach the UI. */
export function dialoguePrefix(source:string):string {
 let i=0;const ws=()=>{while(i<source.length&&/\s/.test(source[i]))i++};
 const string=():{text:string;done:boolean}=>{if(source[i++]!=='"')throw Error();let raw='"';while(i<source.length){const c=source[i++];raw+=c;if(c==='"')return {text:JSON.parse(raw),done:true};if(c==='\\'){if(i===source.length)break;const escape=source[i++];raw+=escape;if(escape==='u'){if(source.length-i<4)break;raw+=source.slice(i,i+4);i+=4}}try{const value=JSON.parse(raw+'"') as string;if(i===source.length)return {text:value.replace(/[\ud800-\udbff]$/u,''),done:false}}catch{}}// Find the longest syntactically valid prefix without exposing an unfinished escape.
  for(let end=raw.length;end>=1;end--)try{return {text:(JSON.parse(raw.slice(0,end)+'"') as string).replace(/[\ud800-\udbff]$/u,''),done:false}}catch{}return {text:'',done:false}}
 const skip=():void=>{ws();if(source[i]==='"'){if(!string().done)throw Error();return}if(source[i]==='{'||source[i]==='['){const end=source[i++]==='{'?'}':']';while(i<source.length){if(source[i]===end){i++;return}if(source[i]==='"'||source[i]==='{'||source[i]==='[')skip();else i++}throw Error()}while(i<source.length&&!/[,}\]]/.test(source[i]))i++};
 try{ws();if(source[i++]!=='{')return '';while(i<source.length){ws();const key=string();if(!key.done)return '';ws();if(source[i++]!==':')return '';ws();if(key.text==='text')return string().text;skip();ws();if(source[i++]!==',')return ''}}catch{}return ''
}
export class ChatSSEDecoder {
 private decoder=new TextDecoder('utf-8',{fatal:true});private pending=''
 constructor(private receive:(data:string)=>void){}
 push(bytes:Uint8Array){this.pending+=this.decoder.decode(bytes,{stream:true});this.drain()}
 private drain(){let m;while((m=/\r?\n\r?\n/.exec(this.pending))){const frame=this.pending.slice(0,m.index);this.pending=this.pending.slice(m.index+m[0].length);const data=frame.split(/\r?\n/).filter(s=>s.startsWith('data:')).map(s=>s.slice(5).trimStart()).join('\n');if(data)this.receive(data)}}
 end(){this.pending+=this.decoder.decode();this.drain();if(this.pending.trim())throw Error('Incomplete SSE response')}
}
