import type {Anime25DRuntime} from '../engine/anime25d/Anime25DRuntime'
import type {ChatMeaning} from '../../electron/shared/character-chat-semantics'
/** Bounded head/gaze presets only; no task, interaction or pack motion event. */
export function playChatGesture(runtime:Anime25DRuntime,meaning:ChatMeaning,signal:AbortSignal){
 const face=runtime.getBaseFaceGeometry()?.face;if(!face||!['nod','tilt','shake','glance_away'].includes(meaning.gesture)||signal.aborted)return;
 const lease=runtime.sourceHost.acquire({slot:'character-chat-gesture',ownerId:'character-chat',priority:35});const start=performance.now();let frame=0;const stop=()=>{cancelAnimationFrame(frame);lease.release();signal.removeEventListener('abort',stop)};signal.addEventListener('abort',stop,{once:true});
 const tick=(now:number)=>{const t=(now-start)/650;if(t>=1||signal.aborted){stop();return}const amount=(.025+Math.min(.5,meaning.intensity)*.06)*Math.sin(Math.PI*t);lease.update(meaning.gesture==='nod'?{angleY:amount*Math.sin(t*Math.PI*2)}:meaning.gesture==='tilt'?{angleZ:amount}:meaning.gesture==='shake'?{angleX:amount*Math.sin(t*Math.PI*2)}:{eyeX:amount*2});frame=requestAnimationFrame(tick)};frame=requestAnimationFrame(tick)
}
