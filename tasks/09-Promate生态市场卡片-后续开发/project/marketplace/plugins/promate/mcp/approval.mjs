// Host hook grants are short-lived, one-use local snapshots, never tool parameters.
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { argsHash, configPath, isPendingExpired, readUserMessageHead, stateDir, withSessionState, writeState } from '../hooks/lib.mjs';
export const WRITE_NAMES = new Set(['mark_done','mark_delivered','set_stage','add_artifact','upload_skill','update_artifact','remove_artifact','retry_writeback','upload_skill_version','uninstall_resource']);
export function approvalDestination(ctx) {
  let revision=null;
  try{const stat=lstatSync(configPath(),{bigint:true});revision=`${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.size}`;}catch{/* env-only source */}
  return argsHash({url:ctx.url,key:ctx.key,profile:ctx.profile,revision});
}
export function approvedCall(session, tool, input, destination, object, messageId) {
  return { session, tool, argsHash:argsHash(input), destination, objectHash:argsHash(object),
    messageId, createdAt:Date.now() };
}
export function consumeApproval(name, input, ctx, object) {
  const hash=argsHash(input), destination=approvalDestination(ctx), objectHash=argsHash(object);
  let names;
  try { names=readdirSync(stateDir()).filter(x=>x.endsWith('.json')); } catch { names=[]; }
  for (const file of names) {
    let grant;
    try {
      const path=join(stateDir(),file),stat=lstatSync(path);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.uid!==process.getuid()||stat.mode&0o077)continue;
      grant=JSON.parse(readFileSync(path,'utf8')).approvedCall;
    } catch { continue; }
    // Use the original session ID for cleaned/hashed file names.
    if (!grant || grant.tool!==`mcp__promate__${name}` || grant.argsHash!==hash || grant.destination!==destination) continue;
    let accepted=false;
    withSessionState(grant.session,(state)=>{
      const current=state.approvedCall;
      if (!current || current.argsHash!==hash || current.destination!==destination || current.tool!==grant.tool) return;
      delete state.approvedCall; writeState(grant.session,state);
      accepted=!isPendingExpired(current) && current.objectHash===objectHash
        && typeof current.messageId==='string' && readUserMessageHead(grant.session).current===current.messageId;
    });
    if (accepted) return;
    throw Error('实际对象、文件内容或消息已变化，旧确认已失效；请重新发起并确认');
  }
  throw Error('缺少本次实际对象的一次性确认，请重新发起并独立回复「确认」');
}
