import { containsPackage, readUpload, rpc } from './client.mjs';
import { uninstallSnapshot } from './resources.mjs';
export const UPLOAD_TOOLS=new Set(['upload_skill','upload_skill_version']);
export function uploadSnapshot(file) { return {path:file.path,fileName:file.fileName,size:file.size,sha256:file.sha256}; }
export async function writebackSnapshot(input,ctx) {
  if(!Number.isSafeInteger(input.outboxId)||input.outboxId<=0)throw Error('请提供具体失败回写任务 outboxId');
  const detail=await rpc(ctx,'get_requirement',{outboxId:input.outboxId},{timeout:2000}),task=detail.writeback;
  if(!task||Number(task.outboxId)!==input.outboxId||!Array.isArray(task.writeFields)||!task.writeFields.length||task.writeFields.some(x=>!['done','delivered'].includes(x)))throw Error('平台尚未升级或缺少具体回写任务目标，不能安全确认重试');
  for(const field of task.writeFields){if(typeof task[field==='done'?'requestedDone':'requestedDelivered']!=='boolean')throw Error('回写任务目标不完整');}
  return {outboxId:input.outboxId,requirementId:detail.id,title:detail.title??'',writeFields:task.writeFields,
    requestedDone:task.writeFields.includes('done')?task.requestedDone:null,requestedDelivered:task.writeFields.includes('delivered')?task.requestedDelivered:null};
}
export async function objectSnapshot(name,input,ctx) {
  if(UPLOAD_TOOLS.has(name)){
    if(containsPackage(input)||Object.hasOwn(input,'fileName'))throw Error('插件上传只接受 filePath，不接受模型提供的文件内容或 fileName');
    return uploadSnapshot(readUpload(input.filePath));
  }
  if(name==='retry_writeback')return writebackSnapshot(input,ctx);
  if(name==='uninstall_resource')return uninstallSnapshot(input,ctx);
  return {};
}
