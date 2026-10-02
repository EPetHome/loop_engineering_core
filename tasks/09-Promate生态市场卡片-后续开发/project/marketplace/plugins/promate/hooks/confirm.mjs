#!/usr/bin/env node
// Nine writes + set_stage: independent user reply, same actual object, one allowance.
import {
  argsHash, isPendingExpired, log, readConfig, readStdinJson, readUserMessageHead,
  redact, withSessionState, writeState,
} from './lib.mjs';
import { context, rpc } from '../mcp/client.mjs';
import { approvalDestination, approvedCall, WRITE_NAMES } from '../mcp/approval.mjs';
import { objectSnapshot, UPLOAD_TOOLS } from '../mcp/snapshots.mjs';

const BOUND_TOOLS = new Set([...UPLOAD_TOOLS,'retry_writeback','uninstall_resource']);
const PREFIX = '【需要用户确认】请把下面的操作和参数原样告诉用户，并询问是否确认；用户独立回复「确认」后，用完全相同的参数重新调用。取消或修改参数须重新确认。';
function decision(permissionDecision, reason) {
  process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision,permissionDecisionReason:redact(reason)}})+'\n');
}
async function titleOf(id,ctx) {
  try {
    if(!ctx.key||!id)return '';
    const detail=await rpc(ctx,'get_requirement',{requirementId:id},{timeout:2000});
    return typeof detail.title==='string'?redact(detail.title,ctx.key):'';
  } catch { log('需求标题不可用，仍须按 ID 和参数确认');return ''; }
}
async function reasonFor(name,input,ctx,snapshot) {
  const id=String(input.requirementId??'未提供');
  const title=BOUND_TOOLS.has(name)?'':await titleOf(input.requirementId,ctx);
  const target=title?`需求 ${id}《${title}》`:`需求 ${id} `;
  let reason;
  if(name==='mark_done'||name==='mark_delivered'||name==='set_stage')reason=`将${target}${name==='mark_done'?'标记为已完成':'标记为已交付研发'}，并回写飞书需求表`;
  else if(name==='add_artifact')reason=`给${target}登记产出物「${input.title??''}」（${input.documentUrl??''}）`;
  else if(name==='update_artifact')reason=`修改${target}的产出物 ${input.artifactId}，仅修改本次所列字段`;
  else if(name==='remove_artifact')reason=`可撤销删除${target}的产出物 ${input.artifactId}（不彻底删除）`;
  else if(name==='retry_writeback')reason=`重试任务 ${snapshot.outboxId}，需求 ${snapshot.requirementId}《${snapshot.title}》；目标 ${JSON.stringify({writeFields:snapshot.writeFields,done:snapshot.requestedDone,delivered:snapshot.requestedDelivered})}`;
  else if(name==='uninstall_resource')reason=`卸载本机技能 ${snapshot.skillId}，版本 ID ${snapshot.versionId}；目录 ${snapshot.directory}；当前文件摘要 SHA-256 ${argsHash(snapshot.files)}（删除前备份并返回位置）`;
  else reason=`${name==='upload_skill_version'?`上传技能 ${input.skillId} 的新版 ${input.version}`:`上传技能「${input.name??''}」`}（${snapshot.fileName}），提交管理员审核；大小 ${snapshot.size} bytes；SHA-256 ${snapshot.sha256}`;
  const shown={...input};
  for(const key of ['contentBase64','fileContentBase64'])if(Object.hasOwn(shown,key))shown[key]='[不接受文件内容，请改用 filePath]';
  return redact(`${reason}\n参数：${JSON.stringify(shown)}\n确认放行不代表业务成功；回写提交不代表飞书已更新。`,ctx.key);
}
try {
  const event=readStdinJson(),tool=event?.tool_name,name=typeof tool==='string'?tool.replace(/^mcp__promate__/,''):'';
  if(!WRITE_NAMES.has(name)||!event.tool_input||typeof event.tool_input!=='object'||Array.isArray(event.tool_input))throw Error('写操作输入无效');
  const session=typeof event.session_id==='string'?event.session_id.trim():'',ctx=context(readConfig(true));
  const snapshot=await objectSnapshot(name,event.tool_input,ctx),reason=await reasonFor(name,event.tool_input,ctx,snapshot);
  if(!session)decision('deny',`${PREFIX}\n${reason}\n当前会话无法记录确认，请到 Promate 网页上操作。`);
  else {
    const hash=argsHash(event.tool_input),objectHash=argsHash(snapshot),destination=approvalDestination(ctx);
    withSessionState(session,state=>{
      const pending=state.pendingConfirm,messageId=readUserMessageHead(session).current,now=Date.now();
      const confirmed=pending?.confirmed===true&&pending.tool===tool&&pending.argsHash===hash
        &&pending.objectHash===objectHash&&pending.destination===destination&&!isPendingExpired(pending,now)
        &&Number.isFinite(pending.confirmedAt)&&pending.confirmedAt>=pending.createdAt&&pending.confirmedAt<=now
        &&typeof pending.messageId==='string'&&pending.messageId===messageId;
      if(confirmed){
        const next={...state,at:now};delete next.pendingConfirm;
        next.approvedCall=approvedCall(session,tool,event.tool_input,destination,snapshot,messageId);
        writeState(session,next);
        if(readUserMessageHead(session).current!==messageId)throw Error('确认已被新消息撤销');
        decision('allow',`用户已确认：${reason}`);
      }else{
        delete state.approvedCall;
        writeState(session,{...state,at:now,pendingConfirm:{tool,argsHash:hash,objectHash,destination,messageId,text:reason,createdAt:now,confirmed:false}});
        decision('deny',`${PREFIX}\n${reason}\n文件内容或实际对象变化后必须重新确认。`);
      }
    });
  }
}catch(error){
  log('写操作确认状态异常，已阻止调用');
  try{decision('deny',`无法安全确认此写操作：${redact(error.message)}；请检查本地配置／文件／任务后重新发起确认，也可到 Promate 网页操作。`);}catch{process.exitCode=2;}
}
