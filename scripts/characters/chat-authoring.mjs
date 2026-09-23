/** Authoring candidates stay out of runtime data; only reviewed intent is compiled. */
/** @param {any} tools @param {{models?:any[],profile?:any,defaultPoseId?:string}} options @param {string[]} poseIds @param {any} [existing] */
export function compileChatAuthoring(tools,{models=[],profile,defaultPoseId}={},poseIds,existing){
 const current=existing?tools.validateChatDefinition(existing,poseIds,true).value:tools.emptyChat();const report=[];const ids=new Set(current.presentation.rules.map(r=>r.id));
 if(profile&&!existing)current.profile=profile;
 if(profile?.displayName!==undefined)current.profile.displayName=profile.displayName;
 if(defaultPoseId&&!current.presentation.defaultPoseId)current.presentation.defaultPoseId=defaultPoseId;
 for(const model of models){const meaning=model.intendedMeaning;
  if(!meaning){report.push({poseId:model.id,status:'unmapped',reason:'No explicit production intent; names are not classified'});continue}
  if(model.meaningReview!=='confirmed'){report.push({poseId:model.id,status:'needs-review',reason:'Production intent requires visual confirmation'});continue}
  const rule={id:meaning.id||'authored-'+model.id,when:meaning.when,poseId:model.id,motionPolicy:meaning.motionPolicy||'chat-safe',priority:meaning.priority??0,weight:meaning.weight??1,...(meaning.intensity?{intensity:meaning.intensity}:{})};
  if(ids.has(rule.id)){report.push({poseId:model.id,ruleId:rule.id,status:'confirmed',preserved:true});continue}
  tools.validateChatDefinition({schemaVersion:1,presentation:{rules:[rule]}},poseIds,true);current.presentation.rules.push(rule);ids.add(rule.id);report.push({poseId:model.id,ruleId:rule.id,status:'confirmed',preserved:false})
 }
 return {chat:tools.validateChatDefinition(current,poseIds,true).value,report};
}
