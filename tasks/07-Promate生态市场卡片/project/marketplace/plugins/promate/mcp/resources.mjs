// Local managed skills + durable result outbox. Data lives outside replaceable plugin caches.
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { argsHash, promateHome } from '../hooks/lib.mjs';
import { consumeApproval } from './approval.mjs';
import { context, program, requireModern, rpc, sha256, skillsPath, stillCurrent, UPLOAD_LIMIT } from './client.mjs';
import { unpackSkill } from './packages.mjs';
import { withMutex } from './recovery-page.mjs';

const OWNER = '.promate-owner.json';
export const LOCAL_NAMES = new Set(['install_resource','uninstall_resource','my_installed']);
function directory(path) {
  if (!existsSync(path)) mkdirSync(path,{recursive:true,mode:0o700});
  const stat=lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid!==process.getuid() || stat.mode & 0o022) throw Error('本机资源目录归属或权限不安全');
  return realpathSync(path);
}
function paths(ctx) {
  const home=directory(join(promateHome(),'resources')), skills=directory(ctx.skills || skillsPath());
  const scope=directory(join(home,argsHash({url:ctx.url,profile:ctx.profile,skills})));
  return {scope,skills,db:join(scope,'installed.json'),journal:join(scope,'transaction.json'),backups:directory(join(scope,'backups'))};
}
function atomic(file,value) {
  const temp=file+'.'+randomUUID()+'.tmp';
  try { writeFileSync(temp,JSON.stringify(value)+'\n',{flag:'wx',mode:0o600});renameSync(temp,file); }
  finally { try { unlinkSync(temp); } catch { /* committed */ } }
}
function readJson(file,fallback) {
  if (!existsSync(file)) return fallback;
  const stat=lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid!==process.getuid() || stat.mode & 0o077) throw Error('本机归属记录不安全');
  return JSON.parse(readFileSync(file,'utf8'));
}
function store(p,ctx) {
  const db=readJson(p.db,{schema:1,url:ctx.url,profile:ctx.profile,skills:p.skills,records:{},versions:[],queue:[],identities:{},attempts:{}});
  if (db.schema!==1 || db.url!==ctx.url || db.profile!==ctx.profile || db.skills!==p.skills || !db.records || !Array.isArray(db.queue) || !Array.isArray(db.versions)) throw Error('平台或 profile 归属记录不匹配／损坏');
  return db;
}
function tree(dir) {
  const files={}; let total=0;
  function scan(base,relative='') {
    for (const item of readdirSync(base,{withFileTypes:true})) {
      const path=join(base,item.name), key=relative ? `${relative}/${item.name}` : item.name, stat=lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isDirectory() && (!stat.isFile() || stat.nlink!==1)) throw Error('技能目录含链接或未知内容，按冲突处理');
      if (stat.isDirectory()) scan(path,key);
      else { total+=stat.size;if(total>100*1024*1024)throw Error('本机技能内容超过 100MB，未覆盖或删除');files[key]=sha256(readFileSync(path)); }
    }
  }
  scan(dir);return files;
}
function verifyOwner(p,record,location=record?.directory) {
  if (!record || resolve(record.directory)!==join(p.skills,record.skillName)) throw Error('安装目录不在本 profile 技能边界内');
  // A transaction moves the SAME inode to its private backup/stage, never adopts a copy.
  if(location!==record.directory && ![p.backups,p.scope].includes(dirname(location))) throw Error('恢复目录越过原归属边界');
  const stat=lstatSync(location);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid!==process.getuid() || stat.mode & 0o022 || stat.dev!==record.dev || stat.ino!==record.ino) throw Error('目标目录已被替换或不在归属记录里，按冲突处理；不会覆盖或删除');
  const owner=readJson(join(location,OWNER),null);
  if(owner?.installationId!==record.installationId || owner?.skillId!==record.skillId)throw Error('目标目录归属未知，不会覆盖或删除');
}
function verifyRecord(p,record) {verifyOwner(p,record);return tree(record.directory);}
function queue(db,ctx,memberId,path,event) {
  db.queue.push({id:randomUUID(),url:ctx.url,profile:ctx.profile,credential:ctx.credential,memberId:memberId==null?null:String(memberId),path,event});
}
async function identity(p,db,ctx) {
  try {
    const data=await program(ctx,'identity',undefined,{method:'GET',timeout:1500});
    const id=data?.memberId;
    if(!(Number.isSafeInteger(id)&&id>0 || typeof id==='string'&&/^[A-Za-z0-9._-]{1,128}$/.test(id))){const error=Error('平台身份无效，不能推测原成员');error.status=502;throw error;}
    const member=String(id);db.identities[ctx.credential]=member;atomic(p.db,db);return member;
  } catch(error) {
    if (error.status || !db.identities[ctx.credential]) throw error;
    return db.identities[ctx.credential]; // only this previously authenticated Key/platform/profile
  }
}
async function flush(p,db,ctx,memberId) {
  let submitted=0;const deadline=Date.now()+2500;
  for (const pending of [...db.queue]) {
    if(Date.now()>deadline)break;
    if (pending.url!==ctx.url || pending.profile!==ctx.profile || (pending.memberId!=null?pending.memberId!==String(memberId):pending.credential!==ctx.credential)) continue;
    if(pending.memberId==null){pending.memberId=String(memberId);atomic(p.db,db);}
    try { await program(ctx,pending.path,pending.event,{timeout:1500}); }
    catch { break; } // only reports are retried; never reinstall or replay business writes
    db.queue=db.queue.filter(item=>item.id!==pending.id);atomic(p.db,db);submitted++;
  }
  return {submitted,pending:db.queue.length};
}
function safeTransaction(p,tx) {
  const inside=(path,root)=>typeof path==='string' && resolve(path).startsWith(root+sep);
  if (tx.scope!==p.scope || tx.skills!==p.skills || !inside(tx.backup,p.backups) || tx.stage && !inside(tx.stage,p.scope)) throw Error('中断记录目录归属未知，拒绝恢复');
  for (const record of [tx.old,tx.next].filter(Boolean)) {
    if (resolve(record.directory)!==join(p.skills,record.skillName)) throw Error('中断记录越过技能目录边界');
  }
}
function recover(p,db,ctx) {
  const tx=readJson(p.journal,null);if(!tx)return;
  safeTransaction(p,tx);
  const committed=tx.operation==='UNINSTALL' ? !db.records[tx.skillId] : db.records[tx.skillId]?.installationId===tx.next?.installationId;
  const hasBackup=tx.old && existsSync(tx.backup);
  // Preflight ALL moved objects before any recursive delete or rollback rename.
  if(hasBackup){verifyOwner(p,tx.old,tx.backup);tree(tx.backup);}
  if(tx.stage&&existsSync(tx.stage)){verifyOwner(p,tx.next,tx.stage);tree(tx.stage);}
  if (!committed) {
    let removeNext=false;
    if (tx.next && existsSync(tx.next.directory)) {
      const owner=readJson(join(tx.next.directory,OWNER),null);
      if(owner?.installationId===tx.next.installationId){verifyRecord(p,tx.next);removeNext=true;}
      else if(tx.old?.directory===tx.next.directory && owner?.installationId===tx.old.installationId && !hasBackup)verifyRecord(p,tx.old);
      else throw Error('恢复目标出现未知目录，拒绝覆盖；备份及中断记录保留');
    }
    if(hasBackup&&existsSync(tx.old.directory)&&!(removeNext&&tx.old.directory===tx.next.directory))throw Error('恢复旧目录有冲突，旧版备份保留');
    if(removeNext)rmSync(tx.next.directory,{recursive:true});
    if(hasBackup)renameSync(tx.backup,tx.old.directory);
    queue(db,{...ctx,url:tx.url,profile:tx.profile,credential:tx.credential},tx.memberId,'events',
      {...tx.event,success:false,errorCode:'INTERRUPTED',errorMessage:'本机操作中断，已回退至原归属'});
    atomic(p.db,db);
  }
  if(tx.stage&&existsSync(tx.stage))rmSync(tx.stage,{recursive:true});
  unlinkSync(p.journal);
}
export function uninstallSnapshot(input,ctx=context()) {
  if(!Number.isSafeInteger(input?.skillId)||input.skillId<=0)throw Error('skillId 必须是正整数');
  const p=paths(ctx),db=store(p,ctx),record=db.records[String(input.skillId)];
  if(!record)throw Error('只允许卸载本平台／profile 归属记录中的技能');
  return {skillId:record.skillId,versionId:record.versionId,installationId:record.installationId,directory:record.directory,files:verifyRecord(p,record)};
}
function view(record,latest) {
  return {skillId:record.skillId,name:record.name,skillName:record.skillName,installedVersion:record.version,
    installedVersionId:record.versionId,directory:record.directory,latestVersion:latest?.latestVersion??null,
    latestVersionId:latest?.versionId??null,canUpgrade:latest?.status==='PUBLISHED'&&latest?.versionId!=null ? String(latest.versionId)!==String(record.versionId) : null};
}
export function annotateSkills(data,ctx) {
  const p=paths(ctx),db=store(p,ctx);
  const annotate=value=>{
    if(Array.isArray(value))return value.map(annotate);
    if(!value||typeof value!=='object')return value;
    if(value.id!=null&&typeof value.name==='string'&&db.records[String(value.id)])return {...value,localInstallation:view(db.records[String(value.id)],value)};
    return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,annotate(v)]));
  };
  return annotate(data);
}
async function selectSkill(ctx,input) {
  if(input.skillId!==undefined&&input.name!==undefined)throw Error('skillId 与 name 只能提供一个');
  if(input.skillId!==undefined){if(!Number.isSafeInteger(input.skillId)||input.skillId<=0)throw Error('skillId 必须是正整数');return {skillId:input.skillId};}
  if(typeof input.name!=='string'||!input.name.trim())throw Error('请提供 skillId 或完整技能名称');
  const matches=[];let page=1,total=Infinity;
  while((page-1)*100<total){
    const data=await rpc(ctx,'list_skills',{keyword:input.name.trim(),page,size:100});
    const records=data.records??data.items?.records??data.items;
    if(!Array.isArray(records))throw Error('平台技能列表格式无效');
    total=Number(data.total??data.items?.total??records.length);matches.push(...records.filter(x=>x.name===input.name.trim()));
    if(!records.length)break;if(page++>1000)throw Error('候选范围过大，请使用 skillId');
  }
  if(!matches.length)throw Error('没有找到已上架的同名技能');
  if(matches.length>1)return {candidates:matches.map(x=>({skillId:x.id,name:x.name,version:x.latestVersion,author:x.authorName})),message:'同名技能有多个，请用户确定 skillId；本次未安装'};
  return {skillId:matches[0].id};
}
async function install(p,db,ctx,input) {
  let memberId=db.identities[ctx.credential]??null,authenticated=false,skillId,old,event,pack,stage,tx;
  const makeEvent=()=>({skillId,versionId:null,requestId:randomUUID(),operation:old?'UPGRADE':'INSTALL',success:false});
  // Only an explicit, previously known object + this proven source/member can fail before probing.
  if(input.name===undefined&&Number.isSafeInteger(input.skillId)&&input.skillId>0&&db.records[String(input.skillId)]&&memberId!==null){skillId=input.skillId;old=db.records[String(skillId)];event=makeEvent();}
  try {
    await requireModern(ctx);
    memberId=await identity(p,db,ctx);authenticated=true;await flush(p,db,ctx,memberId);
    const selected=await selectSkill(ctx,input);if(selected.candidates)return selected;
    skillId=selected.skillId;old=db.records[String(skillId)];
    if(old)event??=makeEvent();
    const detail=await rpc(ctx,'get_skill',{skillId}),skill=detail.skill??detail;
    if(skill.source!=='SELF_BUILT')return {skillId,sourceUrl:skill.sourceUrl,message:'本批只安装平台自建技能；外部技能请查看来源链接'};
    event??=makeEvent();
    if(skill.status!=='PUBLISHED')throw Error('只安装已上架技能的正式版，作者／管理员也不能安装待审版');
    if(old&&String(old.versionId)===String(skill.versionId)&&argsHash(verifyRecord(p,old))===argsHash(old.files))return {...view(old,skill),reused:true,report:await flush(p,db,ctx,memberId),message:'本机同版已安装，未重复下载或安装；请新开对话加载'};
    const operation=old?'UPGRADE':'INSTALL',saved=db.attempts[String(skillId)];
    const attempt=saved?.credential===ctx.credential?saved:{requestId:randomUUID(),credential:ctx.credential};
    db.attempts[String(skillId)]=attempt;atomic(p.db,db);
    pack=await program(ctx,`skills/${skillId}/download`,{requestId:attempt.requestId},{limit:15*1024*1024});
    if(pack.skillId!==skillId||!Number.isSafeInteger(pack.versionId)||pack.versionId<=0||typeof pack.version!=='string'||pack.requestId!==attempt.requestId||!Number.isSafeInteger(pack.size)||pack.size<=0||pack.size>UPLOAD_LIMIT||!/^[a-f0-9]{64}$/.test(pack.sha256||'')||typeof pack.contentBase64!=='string'||pack.contentBase64.length>14*1024*1024)throw Error('分发版本、摘要或大小无效');
    event.versionId=pack.versionId;
    const bytes=Buffer.from(pack.contentBase64,'base64');
    if(bytes.length!==pack.size||sha256(bytes)!==pack.sha256||bytes.toString('base64')!==pack.contentBase64)throw Error('安装包摘要或大小校验失败');
    stage=mkdtempSync(join(p.scope,'stage-'));
    const skillName=unpackSkill(bytes,pack.fileExtension,stage),dest=join(p.skills,skillName);
    if(existsSync(dest)&&old?.directory!==dest)throw Error('同名目录不属于这个资源的归属记录，本次不安装、不覆盖');
    if(old)verifyRecord(p,old);
    const installationId=randomUUID();atomic(join(stage,OWNER),{installationId,skillId});
    // The returned Skill text carries this non-secret provenance token even when a
    // conversation has cached old instructions. Never infer its version from today's directory.
    const markdown=join(stage,'SKILL.md');
    const original=readFileSync(markdown),prior=original.toString('utf8').match(/(?:\r?\n<!-- promate-load:[a-f0-9-]{36} -->\s*)+$/)?.[0];
    // Authors may upload a previously installed file. Replace only trailing local
    // provenance, retaining the platform package digest and all business instructions.
    const body=prior?original.subarray(0,original.length-Buffer.byteLength(prior)):original;
    writeFileSync(markdown,Buffer.concat([body,Buffer.from(`\n<!-- promate-load:${installationId} -->\n`)]));
    const stat=lstatSync(stage),next={skillId,name:skill.name,skillName,versionId:pack.versionId,version:pack.version,sha256:pack.sha256,directory:dest,dev:stat.dev,ino:stat.ino,installationId,files:tree(stage)};
    const backup=join(p.backups,`${Date.now()}-${randomUUID()}-${old?.skillName??skillName}`);
    event.success=true;
    tx={scope:p.scope,skills:p.skills,skillId,old:old??null,next,stage,backup,operation,event,url:ctx.url,profile:ctx.profile,credential:ctx.credential,memberId};
    atomic(p.journal,tx);
    if(!stillCurrent(ctx))throw Error('平台或 Key 已变化，已停止安装');
    // A renamed skill's new directory is ready before moving the recorded old one.
    if(old?.directory===dest)renameSync(old.directory,backup);
    renameSync(stage,dest);
    if(old&&old.directory!==dest)renameSync(old.directory,backup);
    db.records[String(skillId)]=next;
    db.versions.push({skillId,skillName,directory:dest,versionId:pack.versionId,version:pack.version,loadToken:installationId,memberId,credential:ctx.credential});
    delete db.attempts[String(skillId)];queue(db,ctx,memberId,'events',event);atomic(p.db,db);unlinkSync(p.journal);
    const latest=String(skill.versionId)===String(pack.versionId)?skill:undefined;
    return {...view(next,latest),latestStatus:latest?'known':'unknown',reused:false,backup:old?backup:null,report:await flush(p,db,ctx,memberId),message:'已安装正式版；请新开 WorkBuddy 对话加载，当前／旧对话不保证生效。回报失败只补报，不重装'};
  } catch(error) {
    if(tx&&existsSync(p.journal)){ recover(p,store(p,ctx),ctx); }
    else if(event&&memberId!==null){queue(db,ctx,memberId,'events',{...event,success:false,errorCode:event.versionId===null?'VERSION_UNKNOWN':'INSTALL_FAILED',errorMessage:'本机安装未完成；未知版本不归因到当前正式版'});atomic(p.db,db);}
    if(stage&&existsSync(stage))rmSync(stage,{recursive:true});
    const fresh=store(p,ctx);
    // A known local failure has ended this operation. A later active request may
    // pick the new formal version; only unconfirmed downloads / process crashes retain its id.
    if(event&&event.versionId!==null){delete fresh.attempts[String(skillId)];atomic(p.db,fresh);}
    if(authenticated)await flush(p,fresh,ctx,memberId);
    throw error;
  }
}
async function uninstall(p,db,ctx,memberId,input) {
  const snapshot=uninstallSnapshot(input,ctx);consumeApproval('uninstall_resource',input,ctx,snapshot);
  const old=db.records[String(input.skillId)],backup=join(p.backups,`${Date.now()}-${randomUUID()}-${old.skillName}`);
  const event={skillId:old.skillId,versionId:old.versionId,operation:'UNINSTALL',success:true,requestId:randomUUID()};
  atomic(p.journal,{scope:p.scope,skills:p.skills,skillId:old.skillId,old,next:null,stage:null,backup,operation:'UNINSTALL',event,url:ctx.url,profile:ctx.profile,credential:ctx.credential,memberId});
  try {
    if(!stillCurrent(ctx))throw Error('平台或 Key 已变化，未卸载');
    renameSync(old.directory,backup);delete db.records[String(old.skillId)];queue(db,ctx,memberId,'events',event);atomic(p.db,db);unlinkSync(p.journal);
    return {skillId:old.skillId,uninstalled:true,backup,report:await flush(p,db,ctx,memberId),message:'已移出技能目录，备份完整保留；新对话生效'};
  } catch(error){recover(p,store(p,ctx),ctx);throw error;}
}
export function captureLoadSources(name,ctx) {
  const p=paths(ctx),db=store(p,ctx),tx=readJson(p.journal,null),records=Object.values(db.records);
  if(tx?.next){safeTransaction(p,tx);records.push(tx.next);}
  return records.filter(r=>r.skillName===name).flatMap(r=>{
    try{verifyOwner(p,r);return [{skillId:r.skillId,skillName:r.skillName,directory:r.directory,dev:r.dev,ino:r.ino,installationId:r.installationId,versionId:r.versionId}];}
    catch{return [];}
  });
}
function loadEvent(p,db,metadata,stable=true) {
  // Pre captures the actual managed source. A copied historical path cannot borrow
  // the current differently-named directory's ownership. Tokens alone are not ownership.
  const sources=(metadata.sources||[]).filter(s=>s.skillName===metadata.name&&resolve(s.directory)===join(p.skills,s.skillName)&&(!metadata.base||s.directory===metadata.base));
  const permitted=(source,version)=>{
    if(!stable)return true; // persist identified metadata BEFORE waiting for a switching transaction
    const current=db.records[String(source.skillId)],formal=Number.isSafeInteger(source.versionId)&&source.versionId>0;
    const proved=formal&&version?.versionId===source.versionId&&version?.loadToken===source.installationId;
    let present=true;
    try{lstatSync(source.directory);}catch(error){if(error.code==='ENOENT')present=false;else return false;}
    // Pre already verified this exact managed instance and formal mapping. A normal
    // rollback/rename can remove it; neither journal cleanup nor absent current erases that fact.
    if(!present&&formal)return version?proved:true;
    if(current?.directory===source.directory){try{verifyOwner(p,current);return true;}catch{/* do not adopt a replacement */}}
    if(proved){try{verifyOwner(p,source);return true;}catch{return false;}}
    // Compatibility with an older Pre binding still requires a live managed current.
    if(!current)return false;
    try{verifyOwner(p,current);}catch{return false;}
    return !present&&version?.loadToken===source.installationId;
  };
  const proven=sources.filter(s=>Number.isSafeInteger(s.versionId)&&s.versionId>0)
    .map(s=>({skillId:s.skillId,versionId:s.versionId,loadToken:s.installationId,directory:s.directory}));
  const versions=[...db.versions,...(metadata.identified||[]),...proven];
  const actual=versions.filter(v=>metadata.tokens.includes(v.loadToken)&&v.directory===metadata.base&&sources.some(s=>s.skillId===v.skillId&&permitted(s,v)));
  const choices=[...new Map(actual.map(v=>[`${v.skillId}:${v.versionId}`,v])).values()];
  const owned=sources.find(s=>permitted(s,null));
  if(choices.length!==1&&!owned)return null;
  const selected=choices.length===1?choices[0]:owned,unknown=choices.length!==1;
  return {skillId:selected.skillId,versionId:unknown?null:selected.versionId,requestId:metadata.requestId,success:!metadata.failed&&!unknown,
    ...(unknown?{errorCode:'VERSION_UNKNOWN',errorMessage:metadata.failed?'技能说明加载失败；实际版本未知':'说明可能已加载，但版本归因失败；不计成功加载'}:metadata.failed?{errorCode:'LOAD_FAILED',errorMessage:'技能说明加载失败；不代表业务完成'}:{})};
}
function drainLoads(p,db,ctx) {
  const dir=directory(join(p.scope,'loads-pending')),resolved=new Map();
  for(const name of readdirSync(dir).filter(x=>/^[a-f0-9]{64}\.json$/.test(x))){
    const file=join(dir,name),pending=readJson(file,null);
    if(pending.url!==ctx.url||pending.profile!==ctx.profile||typeof pending.credential!=='string')throw Error('加载队列来源归属未知');
    const requestId=pending.metadata?.requestId??pending.event?.requestId;
    if(requestId!==name.slice(0,-5))throw Error('加载队列事件归属损坏');
    const matched=pending.metadata?loadEvent(p,db,pending.metadata):pending.event; // old already-resolved outbox format
    resolved.set(requestId,matched);
    if(!matched){unlinkSync(file);continue;} // actual source no longer owned; never send success
    if(!db.queue.some(item=>item.path==='loads'&&item.credential===pending.credential&&item.event.requestId===matched.requestId))
      queue(db,pending,db.identities[pending.credential]??null,'loads',matched);
    atomic(p.db,db);unlinkSync(file);
  }
  return resolved;
}
export async function resourceTool(name,input,ctx) {
  const p=paths(ctx);
  // ponytail: one kernel lock per skills directory; serializes all resources/platforms,
  // including same-name conflicts and dual proxies. Per-resource locks only if throughput matters.
  return withMutex(p.skills,'.promate.mutex',async()=>{
    const db=store(p,ctx);recover(p,db,ctx);drainLoads(p,db,ctx);
    if(name==='my_installed'){
      const records=[];let unauthorized=false;
      for(const record of Object.values(db.records)){
        let latest,latestReason;
        try{const detail=await rpc(ctx,'get_skill',{skillId:record.skillId},{timeout:1500});latest=detail.skill??detail;}
        catch(error){latestReason=error.message;if(error.status===401)unauthorized=true;}
        records.push({...view(record,latest),latestStatus:latest?'known':'unknown',...(latestReason?{latestReason}:{})});
      }
      let report={pending:db.queue.length};
      if(ctx.key){try{const member=await identity(p,db,ctx);report=await flush(p,db,ctx,member);}catch(error){if(error.status===401)unauthorized=true;/* offline list remains local */}}
      return {records,report,...(unauthorized?{unauthorized:true}:{}),message:'仅列出此平台／WorkBuddy profile 的受管技能；最新版本未知时不判断升级'};
    }
    if(name==='install_resource')return install(p,db,ctx,input);
    const member=await identity(p,db,ctx);await flush(p,db,ctx,member);
    return uninstall(p,db,ctx,member,input);
  });
}
export async function reportLoad(metadata,ctx) {
  const p=paths(ctx),snapshot=store(p,ctx),tx=readJson(p.journal,null);
  // The host can load a freshly renamed directory just before the atomic registry
  // commit. Its durable transaction already pins the formal version and token.
  if(tx?.next && metadata.tokens.includes(tx.next.installationId) && metadata.base===tx.next.directory){
    safeTransaction(p,tx);
    snapshot.versions.push({...tx.next,loadToken:tx.next.installationId});
  }
  const matched=loadEvent(p,snapshot,metadata,false);
  if(!matched)return {reported:false,reason:'非受管技能或实际归属未知，不伪造版本'};
  const dir=directory(join(p.scope,'loads-pending')),file=join(dir,`${metadata.requestId}.json`);
  // Pin proven formal IDs/token mapping too: rollback can remove tx.next from the
  // registry, but must not erase a real returned version already identified here.
  const identified=snapshot.versions.filter(v=>v.skillId===matched.skillId&&v.versionId===matched.versionId&&metadata.tokens.includes(v.loadToken)&&v.directory===metadata.base)
    .map(({skillId,versionId,loadToken,directory})=>({skillId,versionId,loadToken,directory}));
  const pending={url:ctx.url,profile:ctx.profile,credential:ctx.credential,metadata:{...metadata,identified}};
  const existing=readJson(file,null);
  if(existing&&argsHash(existing)!==argsHash(pending))throw Error('同次加载回报变化，未覆盖原事件');
  if(!existing)atomic(file,pending); // durable metadata only, before lock/network waits; no content
  try {
    return await withMutex(p.skills,'.promate.mutex',async()=>{
      const db=store(p,ctx);recover(p,db,ctx);const resolved=drainLoads(p,db,ctx).get(metadata.requestId);
      if(!resolved)return {reported:false,reason:'实际返回目录不受管，未报告成功'};
      let report={pending:db.queue.length};
      try{const member=await identity(p,db,ctx);report=await flush(p,db,ctx,member);}catch{/* original binding retained */}
      return {reported:true,versionUnknown:resolved.versionId===null,report};
    });
  }catch{return {reported:true,versionUnknown:matched.versionId===null,report:{pending:1},message:'加载元数据已暂存，下次资源查询补报'};}
}
