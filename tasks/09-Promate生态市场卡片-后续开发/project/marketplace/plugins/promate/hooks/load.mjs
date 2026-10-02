#!/usr/bin/env node
// Skill result = instructions loaded, NOT business completed. Only identifiers/outcome upload.
import { argsHash, log, readStdinJson, withSessionState, writeState } from './lib.mjs';
import { context, skillsPath } from '../mcp/client.mjs';
import { captureLoadSources, reportLoad } from '../mcp/resources.mjs';
function responseText(value) {
  if(typeof value==='string')return value;
  if(Array.isArray(value))return value.filter(x=>x.type==='text').map(x=>x.text).join('\n');
  return responseText(value?.content??'');
}
try {
  const event=readStdinJson();
  if(event?.tool_name==='Skill'){
    const session=event.session_id,callId=event.tool_use_id||event.call_id;
    if(typeof session!=='string'||typeof callId!=='string'||!callId)throw Error('缺少可靠宿主调用 ID');
    const current=context(),raw=event.tool_input?.skill||event.tool_input?.command||'',name=typeof raw==='string'?raw.replace(/^\//,'').split(/\s+/)[0]:'';
    if(event.hook_event_name==='PreToolUse'){
      const sources=captureLoadSources(name,current);
      withSessionState(session,state=>{
        const bindings=state.skillLoadBindings||{};
        bindings[callId]={url:current.url,profile:current.profile,skills:skillsPath(),credential:current.credential,sources};
        writeState(session,{...state,skillLoadBindings:bindings});
      });
    }else{
      let bound;
      withSessionState(session,state=>{
        bound=state.skillLoadBindings?.[callId];
      });
      if(!bound)throw Error('缺少调用发生时的来源绑定，未按新身份补报');
      // Credentials never persist in the binding. A change parks reports under the old
      // Key fingerprint; no old event is authenticated/sent with the new Key or profile.
      const ctx=bound.credential===current.credential?{...current,skills:bound.skills}:{...bound,key:''};
      const body=responseText(event.tool_response),base=body.match(/^Base directory for this skill: ([^\r\n]+)\r?\n/),tokens=[...body.matchAll(/<!-- promate-load:([a-f0-9-]{36}) -->/g)].map(x=>x[1]);
      const failed=event.hook_event_name==='PostToolUseFailure'||event.tool_response?.isError===true||event.tool_response?.is_error===true||/^(Error:|Skill .+ failed|Failed )/i.test(body);
      const result=await reportLoad({name,base:base?.[1]??null,tokens,failed,
        requestId:argsHash({url:ctx.url,profile:ctx.profile,session,callId}),sources:bound.sources||[]},ctx);
      // Only consume Pre after durable ID/token/source metadata or a definite non-platform result.
      withSessionState(session,state=>{
        if(argsHash(state.skillLoadBindings?.[callId])===argsHash(bound)){delete state.skillLoadBindings[callId];writeState(session,state);}
      });
      if(result.reported&&(result.versionUnknown||result.report?.pending)){
        process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:event.hook_event_name||'PostToolUse',additionalContext:result.versionUnknown
          ?'Promate：实际加载版本无法确认，仅保留归因失败记录，不计成功加载；这不表示业务失败，也不能说成已完成业务。'
          :'Promate：加载统计暂未全部提交，已按原平台／身份／profile 本机暂存；只补回报，不重放 Skill 或业务操作。'}})+'\n');
      }
    }
  }
}catch{log('技能加载统计未能上报，未伪造版本或业务成功；请后续查询本机安装／回报状态');}
