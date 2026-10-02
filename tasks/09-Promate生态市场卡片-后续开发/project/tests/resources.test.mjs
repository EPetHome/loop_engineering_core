import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ProxySession, makeHome, readStateFile, runHook, runHookAsync, startStub, writeConfig, zipFixture } from './helpers.mjs';
const text=(name='managed-fixture',version='v1')=>`---\nname: ${name}\ndescription: Isolated fixture\n---\nFixture release ${version}.\n`;
const hash=b=>createHash('sha256').update(b).digest('hex');
function installedText(dir,original){const value=readFileSync(join(dir,'SKILL.md'),'utf8');assert.equal(value.slice(0,original.length),original);assert.match(value.slice(original.length),/^\n<!-- promate-load:[a-f0-9-]{36} -->\n$/);return value;}
function loadedBody(dir){return `Base directory for this skill: ${dir}\n`+readFileSync(join(dir,'SKILL.md'),'utf8').replace(/^---\n[\s\S]*?\n---\n/,'').trim();}
async function load(home,body,{session='load-fixture',callId='fixture-call',name='managed-fixture',failure=false,preEnv={},postEnv={}}={}){
  const event={session_id:session,tool_name:'Skill',tool_input:{skill:name},call_id:callId,tool_use_id:callId,version:'host-version-not-resource'};
  assert.equal((await runHookAsync('load.mjs',{...event,hook_event_name:'PreToolUse'},{home,env:preEnv})).status,0);
  return runHookAsync('load.mjs',{...event,hook_event_name:failure?'PostToolUseFailure':'PostToolUse',tool_response:body},{home,env:postEnv});
}
const call=(id,name,args={})=>({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:args}});
const data=reply=>{assert.equal(reply.result?.isError,false,JSON.stringify(reply));return reply.result.structuredContent;};
const decision=r=>JSON.parse(r.stdout).hookSpecificOutput.permissionDecision;
async function approve(home,name,input,session='resources-approval'){
  const event={session_id:session,tool_name:`mcp__promate__${name}`,tool_input:input};
  assert.equal(decision(await runHookAsync('confirm.mjs',event,{home})),'deny');
  assert.equal(runHook('route.mjs',{session_id:session,prompt:'确认'},{home}).status,0);
  assert.equal(decision(await runHookAsync('confirm.mjs',event,{home})),'allow');
}
const registryPath=home=>join(home,'resources',readdirSync(join(home,'resources'))[0],'installed.json');
const readRegistry=home=>JSON.parse(readFileSync(registryPath(home)));
async function interruptedUpgrade(home,state,{rename=false,uninstall=false,afterOldMove=false,pause='kill'}={}){
  state.version=2;if(rename)state.name='renamed-fixture';
  const ready=join(home,'repair-barrier-ready'),preload=join(home,'repair-barrier.cjs');
  const condition=uninstall||afterOldMove?`String(b).includes('/backups/')`:`String(a).includes('/stage-')&&String(b).endsWith('/${state.name}')`;
  writeFileSync(preload,`const fs=require('fs');const original=fs.renameSync;fs.renameSync=function(a,b){const r=original.apply(this,arguments);if(${condition}){fs.writeFileSync(${JSON.stringify(ready)},'ready');${pause==='stop'?"process.kill(process.pid,'SIGSTOP');":"Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);"}}return r;};require('module').syncBuiltinESMExports();`);
  const proxy=new ProxySession({home,env:{NODE_OPTIONS:`--require=${preload}`}});
  const reached=new Promise((resolve,reject)=>{const w=watch(home,()=>{if(existsSync(ready)){w.close();resolve();}});setTimeout(()=>{w.close();reject(Error('repair SIGKILL barrier not reached'));},10000).unref();});
  proxy.child.stdin.write(JSON.stringify(call('interrupted',uninstall?'uninstall_resource':'install_resource',{skillId:7}))+'\n');await reached;
  return proxy;
}
async function killAtBarrier(proxy){const closed=once(proxy.child,'close');proxy.child.kill('SIGKILL');await closed;}
async function platform(){
  const state={version:1,name:'managed-fixture',label:'Platform label',sourceFooter:'',downloads:[],events:[],loads:[],uploads:[],reportFail:false,tamper:false,member:'fixture-member',source:'SELF_BUILT',search:null,taskDone:true,downloadFail:false,writes:[],packages:new Map(),legacy:false,legacyCalls:0,legacyDownloads:0,acquisitions:0,initFail:null,previewFail:null};
  const stub=await startStub(({path,request,headers})=>{
    assert.equal(headers['x-promate-capabilities'],'mcp-tools-v2');
    const ok=data=>({body:{success:true,code:'OK',message:'success',data}});
    if(path.endsWith('/resources/identity'))return ok({memberId:state.member});
    if(path.endsWith('/download')){
      state.downloads.push(request.requestId);
      if(!state.packages.has(request.requestId))state.packages.set(request.requestId,{version:state.version,bytes:Buffer.from(text(state.name,'v'+state.version)+state.sourceFooter)});
      if(state.downloadFail)return {status:503,body:{success:false,code:'UNAVAILABLE'}};
      const {bytes,version}=state.packages.get(request.requestId),skillId=Number(path.match(/skills\/(\d+)/)[1]);
      return ok({skillId,name:'Platform label',versionId:version,version:'v'+version,sha256:state.tamper?'f'.repeat(64):hash(bytes),fileName:'fixture.md',fileExtension:'.md',contentType:'text/markdown',size:bytes.length,requestId:request.requestId,contentBase64:bytes.toString('base64')});
    }
    if(path.endsWith('/resources/events')||path.endsWith('/resources/loads')){
      if(state.reportFail)return {status:503,body:{success:false,code:'UNAVAILABLE'}};
      if(path.endsWith('/loads'))state.loads.push(request);else state.events.push(request);
      return ok({});
    }
    let result={};
    if(request?.method==='initialize'&&state.initFail)return state.initFail==='network'?{disconnect:true}:{status:state.initFail,body:{success:false,code:'UNAVAILABLE'}};
    if(request?.method==='initialize'&&state.legacy)return {body:{jsonrpc:'2.0',id:request.id,result:{capabilities:{tools:{}}}}};
    if(request?.method==='initialize')result={capabilities:{tools:{listChanged:false},promate:{toolset:'mcp-tools-v2',programApi:1}}};
    if(request?.method==='tools/call'){
      const name=request.params.name,args=request.params.arguments;
      if(name==='get_skill'&&state.previewFail)return state.previewFail==='network'?{disconnect:true}:{status:state.previewFail,body:{success:false,code:'UNAVAILABLE'}};
      if(name==='get_skill'&&state.legacy){state.legacyCalls++;state.legacyDownloads++;state.acquisitions++;result={skill:{id:args.skillId},contentBase64:Buffer.from('LEGACY_SIDE_EFFECT_BYTES').toString('base64')};}
      else if(name==='get_skill')result={skill:{id:args.skillId,name:state.label,status:'PUBLISHED',source:state.source,sourceUrl:'https://fixture.test/source',versionId:state.version,latestVersion:'v'+state.version},preview:{content:'fixture'}};
      if(name==='list_skills')result=state.search?state.search(args):{records:[{id:7,name:'Platform label',status:'PUBLISHED',versionId:state.version,latestVersion:'v'+state.version}],total:1};
      if(name==='get_requirement')result={id:13,title:'Fixture requirement',writeback:{outboxId:args.outboxId,status:'FAILED',writeFields:['done'],requestedDone:state.taskDone,requestedDelivered:false}};
      if(['upload_skill','upload_skill_version'].includes(name)){state.uploads.push({name,args});result={status:'PENDING_REVIEW'};}
      if(['mark_done','mark_delivered','set_stage','add_artifact','update_artifact','remove_artifact','retry_writeback'].includes(name))state.writes.push({name,args});
      return {body:{jsonrpc:'2.0',id:request.id,result:{structuredContent:result,content:[{type:'text',text:JSON.stringify(result)}],isError:false}}};
    }
    return {body:{jsonrpc:'2.0',id:request?.id,result}};
  });
  return {stub,state};
}

test('K2/K3/K6/L1 安装正式版、同版复用、回报补发及已装标注，不向对话返包',async()=>{
  const {home,cleanup}=makeHome(),{stub,state}=await platform();writeConfig(home,{url:stub.url,key:'fictional-resource-key'});const proxy=new ProxySession({home});
  try{
    state.reportFail=true;const first=data(await proxy.request(call(1,'install_resource',{skillId:7})));
    assert.equal(first.installedVersion,'v1');assert.equal(first.report.pending,1);
    installedText(first.directory,text());
    assert.doesNotMatch(JSON.stringify(first),/contentBase64|Fixture release/);
    state.reportFail=false;const again=data(await proxy.request(call(2,'install_resource',{skillId:7})));
    assert.equal(again.reused,true);assert.equal(state.downloads.length,1);assert.equal(state.events.length,1);assert.equal(state.events[0].operation,'INSTALL');assert.equal(state.events[0].success,true);
    const listing=data(await proxy.request(call(3,'list_skills')));assert.equal(listing.records[0].localInstallation.installedVersion,'v1');
    state.version=2;const installed=data(await proxy.request(call(4,'my_installed')));assert.equal(installed.records[0].canUpgrade,true);assert.equal(installed.records[0].latestVersion,'v2');
  }finally{proxy.close();await stub.close();cleanup();}
});

test('D-R1 旧端直接get_skill／已装查询／安装共同预览必须零下载零获取，保留本机列表',async()=>{
  const {home,cleanup}=makeHome(),{stub,state}=await platform();writeConfig(home,{url:stub.url,key:'fictional-r1-key'});const proxy=new ProxySession({home});
  try{
    data(await proxy.request(call(1,'install_resource',{skillId:7})));state.legacy=true;
    const preview=await proxy.request(call(2,'get_skill',{skillId:7})),listing=data(await proxy.request(call(3,'my_installed'))),install=await proxy.request(call(4,'install_resource',{skillId:7}));
    console.log('D-R1 legacy effects',JSON.stringify({legacyCalls:state.legacyCalls,legacyDownloads:state.legacyDownloads,acquisitions:state.acquisitions,preview,listing,install}));
    assert.equal(state.legacyCalls,0);assert.equal(state.legacyDownloads,0);assert.equal(state.acquisitions,0);assert.match(preview.result.content[0].text,/平台尚未升级/);assert.equal(preview.result.isError,true);
    assert.equal(listing.records[0].installedVersionId,1);assert.equal(listing.records[0].latestStatus,'unknown');assert.match(listing.records[0].latestReason,/平台尚未升级/);assert.equal(install.result.isError,true);assert.equal(state.downloads.length,1);
  }finally{proxy.close();await stub.close();cleanup();}
});

for(const phase of ['initFail','previewFail'])for(const fail of ['network',503,401])test(`D-R4 ${phase}/${fail} 已核前置失败持久暂存，恢复只补原事件`,async()=>{
    const {home,cleanup}=makeHome(),{stub,state}=await platform();writeConfig(home,{url:stub.url,key:'fictional-r4-original'});const proxy=new ProxySession({home});
    try{
      const first=data(await proxy.request(call(1,'install_resource',{skillId:7}))),beforeBody=readFileSync(join(first.directory,'SKILL.md'),'utf8'),beforeRecord=readRegistry(home).records['7'];state[phase]=fail;state.reportFail=true;
      const result=await proxy.request(call(2,'install_resource',{skillId:7})),db=readRegistry(home);
      console.log('D-R4 pre-download failure',JSON.stringify({phase,fail,result,queue:db.queue,downloads:state.downloads.length}));
      assert.equal(result.result.isError,true);assert.equal(db.queue.length,1);const pending=db.queue[0];assert.equal(pending.memberId,'fixture-member');assert.deepEqual({skillId:pending.event.skillId,versionId:pending.event.versionId,success:pending.event.success,errorCode:pending.event.errorCode},{skillId:7,versionId:null,success:false,errorCode:'VERSION_UNKNOWN'});
      assert.deepEqual(db.records['7'],beforeRecord);assert.equal(readFileSync(join(first.directory,'SKILL.md'),'utf8'),beforeBody);assert.equal(state.downloads.length,1);assert.doesNotMatch(JSON.stringify(pending),/Fixture release|contentBase64|fictional-r4-original/);
      state[phase]=null;state.reportFail=false;state.member='other-member';writeConfig(home,{url:stub.url,key:'fictional-r4-other'});
      assert.equal(data(await proxy.request(call(3,'my_installed'))).report.pending,1);assert.equal(state.events.length,1);
      state.member='fixture-member';writeConfig(home,{url:stub.url,key:'fictional-r4-restored'});assert.equal(data(await proxy.request(call(4,'my_installed'))).report.pending,0);
      assert.equal(state.events.length,2);assert.deepEqual(state.events[1],pending.event);assert.equal(state.downloads.length,1);assert.equal(state.events.filter(x=>x.success).length,1);
    }finally{proxy.close();await stub.close();cleanup();}
});

test('D-R1 新端预览零下载；换Key／来源／profile不复用旧能力，401给原配置入口且列表保留',async()=>{
  const {home,cleanup}=makeHome(),{stub,state}=await platform(),other=await platform();writeConfig(home,{url:stub.url,key:'fictional-r1-first'});const proxy=new ProxySession({home});let foreign;
  try{
    const preview=data(await proxy.request(call(1,'get_skill',{skillId:7})));assert.equal(preview.skill.id,7);assert.equal(state.downloads.length,0);
    data(await proxy.request(call(2,'install_resource',{skillId:7})));state.legacy=true;writeConfig(home,{url:stub.url,key:'fictional-r1-changed'});
    assert.equal((await proxy.request(call(3,'get_skill',{skillId:7}))).result.isError,true);assert.equal(state.legacyCalls,0);
    state.legacy=false;state.initFail=401;const denied=await proxy.request(call(4,'get_skill',{skillId:7}));assert.match(denied.result.content[0].text,/身份验证未通过（401）/);assert.match(denied.result.content[0].text,/\[配置 Key\]/);assert.doesNotMatch(denied.result.content[0].text,/平台尚未升级/);
    const listing=await proxy.request(call(5,'my_installed'));assert.equal(listing.result.structuredContent.records[0].installedVersionId,1);assert.equal(listing.result.structuredContent.records[0].latestStatus,'unknown');assert.match(listing.result.content[0].text,/\[配置 Key\]/);
    for(const status of [403,503,'network']){state.initFail=status;const blocked=await proxy.request(call(status,'get_skill',{skillId:7}));assert.equal(blocked.result.isError,true);assert.match(blocked.result.content[0].text,status==='network'?/连不上/:new RegExp('HTTP '+status));assert.doesNotMatch(blocked.result.content[0].text,/平台尚未升级|configure\//);}
    other.state.legacy=true;writeConfig(home,{url:other.stub.url,key:'fictional-r1-other-source'});assert.equal((await proxy.request(call(6,'get_skill',{skillId:7}))).result.isError,true);assert.equal(other.state.legacyCalls,0);
    foreign=new ProxySession({home,env:{CODEBUDDY_CONFIG_DIR:join(home,'different-profile')}});assert.equal((await foreign.request(call(7,'get_skill',{skillId:7}))).result.isError,true);assert.equal(other.state.legacyCalls,0);assert.equal(state.downloads.length,1);
  }finally{proxy.close();foreign?.close();await stub.close();await other.stub.close();cleanup();}
});

test('D-R4 无原身份／非法参数／未知未选定资源不虚构安装失败记录',async()=>{
  const {home,cleanup}=makeHome(),{stub,state}=await platform();writeConfig(home,{url:stub.url,key:'fictional-r4-no-identity'});const proxy=new ProxySession({home});
  try{
    state.initFail='network';assert.equal((await proxy.request(call(1,'install_resource',{skillId:7}))).result.isError,true);if(existsSync(registryPath(home)))assert.equal(readRegistry(home).queue.length,0);
    state.initFail=null;for(const input of [{skillId:-1},{skillId:7,name:'both'}])assert.equal((await proxy.request(call(JSON.stringify(input),'install_resource',input))).result.isError,true);
    state.search=args=>({records:[{id:args.page===1?7:8,name:'same',latestVersion:'v1'}],total:101});assert.equal(data(await proxy.request(call(2,'install_resource',{name:'same'}))).candidates.length,2);assert.equal(readRegistry(home).queue.length,0);assert.equal(state.events.length,0);assert.equal(state.downloads.length,0);
  }finally{proxy.close();await stub.close();cleanup();}
});

test('K4/K7 两个代理同资源互斥，同名不同资源及摘要篡改拒绝，旧版保留',async()=>{
  const {home,cleanup}=makeHome(),{stub,state}=await platform();writeConfig(home,{url:stub.url,key:'fictional-resource-key'});
  const a=new ProxySession({home}),b=new ProxySession({home});
  try{
    const replies=await Promise.all([a.request(call(1,'install_resource',{skillId:7})),b.request(call(2,'install_resource',{skillId:7}))]);
    assert.equal(replies.map(data).filter(x=>x.reused===false).length,1);assert.equal(state.downloads.length,1);
    const conflict=await b.request(call(3,'install_resource',{skillId:8}));assert.equal(conflict.result.isError,true);assert.match(conflict.result.content[0].text,/同名目录/);
    state.version=2;state.tamper=true;const bad=await a.request(call(4,'install_resource',{skillId:7}));assert.equal(bad.result.isError,true);assert.match(bad.result.content[0].text,/摘要/);
    installedText(join(home,'workbuddy-skills/managed-fixture'),text());
    assert.equal(state.events.filter(x=>x.success===false).length,2);
  }finally{a.close();b.close();await stub.close();cleanup();}
});

test('K3/K5/K7 修改先备份、新name切换、一次性确认卸载及拒绝非归属',async()=>{
  const {home,cleanup}=makeHome(),{stub,state}=await platform();writeConfig(home,{url:stub.url,key:'fictional-resource-key'});const proxy=new ProxySession({home});
  try{
    const first=data(await proxy.request(call(1,'install_resource',{skillId:7})));writeFileSync(join(first.directory,'SKILL.md'),'user-modified fixture');
    state.version=2;state.name='renamed-fixture';const upgrade=data(await proxy.request(call(2,'install_resource',{skillId:7})));
    assert.equal(readFileSync(join(upgrade.backup,'SKILL.md'),'utf8'),'user-modified fixture');assert.equal(existsSync(first.directory),false);assert.equal(upgrade.installedVersion,'v2');
    assert.equal((await proxy.request(call(3,'uninstall_resource',{skillId:7}))).result.isError,true,'no hook grant');
    await approve(home,'uninstall_resource',{skillId:7});const removed=data(await proxy.request(call(4,'uninstall_resource',{skillId:7})));
    assert.equal(existsSync(upgrade.directory),false);installedText(removed.backup,text('renamed-fixture','v2'));
    assert.equal((await proxy.request(call(5,'uninstall_resource',{skillId:7}))).result.isError,true);
    assert.equal(state.events.at(-1).operation,'UNINSTALL');assert.equal(data(await proxy.request(call(6,'my_installed'))).records.length,0);
  }finally{proxy.close();await stub.close();cleanup();}
});

test('K2 重名跨页返回候选；外部技能仅来源链接，不下载',async()=>{
  const {home,cleanup}=makeHome(),{stub,state}=await platform();writeConfig(home,{url:stub.url,key:'fictional-resource-key'});const proxy=new ProxySession({home});
  try{
    state.search=args=>({records:[{id:args.page===1?7:8,name:'same',latestVersion:'v1'}],total:101});
    const choices=data(await proxy.request(call(1,'install_resource',{name:'same'})));assert.deepEqual(choices.candidates.map(x=>x.skillId),[7,8]);assert.equal(state.downloads.length,0);
    state.source='EXTERNAL';const external=data(await proxy.request(call(2,'install_resource',{skillId:7})));assert.equal(external.sourceUrl,'https://fixture.test/source');assert.equal(state.downloads.length,0);
  }finally{proxy.close();await stub.close();cleanup();}
});

test('U1/U2/C1 上传读取真实文件；确认后换内容拒绝，复用同份bytes发送',async()=>{
  const {home,cleanup}=makeHome(),{stub,state}=await platform();writeConfig(home,{url:stub.url,key:'fictional-resource-key'});const proxy=new ProxySession({home});
  const filePath=join(home,'fixture.md'),input={name:'Fixture upload',category:'GENERAL',filePath};
  try{
    await approve(home,'upload_skill',input);writeFileSync(filePath,text('changed'));
    const changed=await proxy.request(call(1,'upload_skill',input));assert.equal(changed.result.isError,true);assert.match(changed.result.content[0].text,/重新/);assert.equal(state.uploads.length,0);
    await approve(home,'upload_skill',input,'upload-again');data(await proxy.request(call(2,'upload_skill',input)));
    assert.equal(Buffer.from(state.uploads[0].args.contentBase64,'base64').toString(),text('changed'));assert.equal(state.uploads[0].args.filePath,undefined);
    assert.equal((await proxy.request(call(3,'upload_skill',input))).result.isError,true,'grant consumed');
    const version={skillId:7,version:'v2',filePath};await approve(home,'upload_skill_version',version,'version');data(await proxy.request(call(4,'upload_skill_version',version)));assert.equal(state.uploads[1].name,'upload_skill_version');
    assert.equal((await proxy.request(call(5,'upload_skill',{...input,filePath:join(home,'missing.md')}))).result.isError,true);
  }finally{proxy.close();await stub.close();cleanup();}
});

test('U1 真实合法zip字节上传；不支持、坏zip、超10MB及模型内容参数明确拒绝',async()=>{
  const {home,cleanup}=makeHome(),{stub,state}=await platform();writeConfig(home,{url:stub.url,key:'fictional-zip-upload'});const proxy=new ProxySession({home});
  try{
    const bytes=zipFixture([{path:'SKILL.md',text:text()},{path:'assets/note.txt',text:'only fixture asset'}]),filePath=join(home,'fixture.zip'),input={name:'Fixture zip',category:'GENERAL',filePath};writeFileSync(filePath,bytes);
    await approve(home,'upload_skill',input,'zip-upload');data(await proxy.request(call(1,'upload_skill',input)));assert.deepEqual(Buffer.from(state.uploads[0].args.contentBase64,'base64'),bytes);assert.equal(state.uploads[0].args.fileName,'fixture.zip');
    for(const [file,value,expected]of [['bad.zip','PK',/有效的 zip/],['unsupported.txt','fixture',/格式不对/],['large.md',Buffer.alloc(10*1024*1024+1),/超过 10MB/]]){
      const filePath=join(home,file);writeFileSync(filePath,value);const rejected=await proxy.request(call(file,'upload_skill',{name:'Rejected',category:'GENERAL',filePath}));assert.equal(rejected.result.isError,true);assert.match(rejected.result.content[0].text,expected);
    }
    const mixed=await proxy.request(call(5,'upload_skill',{...input,fileContentBase64:'must-not-upload'}));assert.equal(mixed.result.isError,true);assert.match(mixed.result.content[0].text,/只接受 filePath/);assert.equal(state.uploads.length,1);
  }finally{proxy.close();await stub.close();cleanup();}
});

test('L1 换Key不把旧队列补到新身份；换profile不沿用归属',async()=>{
  const {home,cleanup}=makeHome(),{stub,state}=await platform();writeConfig(home,{url:stub.url,key:'old-fictional-key'});const a=new ProxySession({home});let b;
  try{
    state.reportFail=true;data(await a.request(call(1,'install_resource',{skillId:7})));state.reportFail=false;state.member='different-fixture-member';writeConfig(home,{url:stub.url,key:'different-fictional-key'});
    const pending=data(await a.request(call(2,'my_installed')));assert.equal(pending.report.pending,1);assert.equal(state.events.length,0);
    b=new ProxySession({home,env:{CODEBUDDY_CONFIG_DIR:join(home,'other-profile')}});
    assert.equal(data(await b.request(call(3,'my_installed'))).records.length,0);
    assert.equal((await b.request(call(4,'install_resource',{skillId:7}))).result.isError,true);
    installedText(join(home,'workbuddy-skills/managed-fixture'),text());
  }finally{a.close();b?.close();await stub.close();cleanup();}
});

test('K7 安装中断后内核锁自动释放，恢复事务并保持目录／归属／回报一致',async()=>{
  const {home,cleanup}=makeHome(),{stub,state}=await platform();writeConfig(home,{url:stub.url,key:'fictional-resource-key'});let first=new ProxySession({home}),interrupted,later;
  try{
    data(await first.request(call(1,'install_resource',{skillId:7})));first.close();state.version=2;
    const ready=join(home,'interrupted-ready'),preload=join(home,'interrupt.cjs');
    writeFileSync(preload,`const fs=require('fs');const rename=fs.renameSync;fs.renameSync=function(a,b){const r=rename.apply(this,arguments);if(String(a).includes('/stage-')&&String(b).endsWith('/managed-fixture')){fs.writeFileSync(${JSON.stringify(ready)},'ready');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}return r;};require('module').syncBuiltinESMExports();`);
    interrupted=new ProxySession({home,env:{NODE_OPTIONS:`--require=${preload}`}});
    const readySignal=new Promise((resolve,reject)=>{const w=watch(home,()=>{if(existsSync(ready)){w.close();resolve();}});setTimeout(()=>{w.close();reject(Error('transaction barrier not reached'));},10000).unref();});
    interrupted.child.stdin.write(JSON.stringify(call(2,'install_resource',{skillId:7}))+'\n');await readySignal;
    const closed=once(interrupted.child,'close');interrupted.child.kill('SIGKILL');await closed;
    later=new ProxySession({home});const resumed=data(await later.request(call(3,'install_resource',{skillId:7})));
    assert.equal(resumed.installedVersion,'v2');installedText(resumed.directory,text('managed-fixture','v2'));
    assert.equal(state.events.some(x=>x.success===false&&x.errorCode==='INTERRUPTED'),true);
    assert.equal(state.downloads[1],state.downloads[2],'same interrupted download operation reuses requestId');
    const scopes=readdirSync(join(home,'resources'));assert.equal(scopes.some(x=>existsSync(join(home,'resources',x,'transaction.json'))),false);
  }finally{first?.close();interrupted?.close();later?.close();await stub.close();cleanup();}
});

test('D-R2 SIGKILL后复制整个next目录保留owner但inode改变，恢复不得删用户文件或原备份',async()=>{
  const {home,cleanup}=makeHome(),{stub,state}=await platform();writeConfig(home,{url:stub.url,key:'fictional-r2-key'});const first=new ProxySession({home});let interrupted,later;
  try{
    const old=data(await first.request(call(1,'install_resource',{skillId:7}))),oldBody=readFileSync(join(old.directory,'SKILL.md'),'utf8');first.close();
    interrupted=await interruptedUpgrade(home,state);await killAtBarrier(interrupted);
    const journal=join(registryPath(home),'../transaction.json'),tx=JSON.parse(readFileSync(journal));assert.equal(readRegistry(home).records['7'].versionId,1);
    const owner=readFileSync(join(tx.next.directory,'.promate-owner.json'),'utf8');renameSync(tx.next.directory,join(home,'held-next'));cpSync(join(home,'held-next'),tx.next.directory,{recursive:true});writeFileSync(join(tx.next.directory,'user-note.txt'),'must survive copied owner');
    const before={savedInode:tx.next.ino,actualInode:lstatSync(tx.next.directory).ino,ownerEqual:readFileSync(join(tx.next.directory,'.promate-owner.json'),'utf8')===owner,backupBody:readFileSync(join(tx.backup,'SKILL.md'),'utf8')};assert.notEqual(before.savedInode,before.actualInode);assert.equal(before.ownerEqual,true);
    later=new ProxySession({home});const result=await later.request(call(3,'my_installed'));
    console.log('D-R2 trigger/result',JSON.stringify({before,result,userFileExists:existsSync(join(tx.next.directory,'user-note.txt')),backupExists:existsSync(tx.backup),journalExists:existsSync(journal),registeredVersion:readRegistry(home).records['7'].versionId,events:state.events}));
    assert.equal(readFileSync(join(tx.next.directory,'user-note.txt'),'utf8'),'must survive copied owner');assert.equal(readFileSync(join(tx.next.directory,'.promate-owner.json'),'utf8'),owner);
    assert.equal(result.result.isError,true);assert.match(result.result.content[0].text,/替换|冲突|未知/);
    assert.equal(readFileSync(join(tx.backup,'SKILL.md'),'utf8'),oldBody);assert.equal(readFileSync(journal,'utf8'),JSON.stringify(tx)+'\n');assert.equal(readRegistry(home).records['7'].versionId,1);
    assert.equal(state.events.filter(x=>x.success).length,1,'no success event for interrupted v2');
  }finally{first.close();interrupted?.close();later?.close();await stub.close();cleanup();}
});

test('D-R2 未知owner与备份实例替换均拒绝，原next／备份／journal不被改动',async()=>{
  for(const replacement of ['next-owner','backup-inode']){
    const {home,cleanup}=makeHome(),{stub,state}=await platform();writeConfig(home,{url:stub.url,key:'fictional-r2-boundary'});const first=new ProxySession({home});let interrupted,later;
    try{
      data(await first.request(call(1,'install_resource',{skillId:7})));first.close();interrupted=await interruptedUpgrade(home,state);await killAtBarrier(interrupted);
      const journal=join(registryPath(home),'../transaction.json'),raw=readFileSync(journal,'utf8'),tx=JSON.parse(raw),nextBody=readFileSync(join(tx.next.directory,'SKILL.md'),'utf8'),backupBody=readFileSync(join(tx.backup,'SKILL.md'),'utf8');
      if(replacement==='next-owner')writeFileSync(join(tx.next.directory,'.promate-owner.json'),JSON.stringify({installationId:'unknown-owner',skillId:7}),{mode:0o600});
      else {renameSync(tx.backup,join(home,'held-backup'));cpSync(join(home,'held-backup'),tx.backup,{recursive:true});assert.notEqual(lstatSync(tx.backup).ino,tx.old.ino);}
      later=new ProxySession({home});const result=await later.request(call(2,'my_installed'));assert.equal(result.result.isError,true);assert.match(result.result.content[0].text,/未知|替换|冲突/);
      assert.equal(readFileSync(join(tx.next.directory,'SKILL.md'),'utf8'),nextBody);assert.equal(readFileSync(join(tx.backup,'SKILL.md'),'utf8'),backupBody);assert.equal(readFileSync(journal,'utf8'),raw);assert.equal(readRegistry(home).records['7'].versionId,1);assert.equal(state.events.length,1);
    }finally{first.close();interrupted?.close();later?.close();await stub.close();cleanup();}
  }
});

test('D-R2 原目录实例未换时改名升级／卸载SIGKILL均回退原目录和原事件，不伪报成功',async()=>{
  for(const mode of ['rename-before-old-move','rename-after-old-move','uninstall']){
    const uninstall=mode==='uninstall';
    const {home,cleanup}=makeHome(),{stub,state}=await platform();writeConfig(home,{url:stub.url,key:'fictional-r2-positive'});const first=new ProxySession({home});let interrupted,later;
    try{
      const old=data(await first.request(call(1,'install_resource',{skillId:7}))),inode=lstatSync(old.directory).ino,oldBody=readFileSync(join(old.directory,'SKILL.md'),'utf8');
      if(uninstall)await approve(home,'uninstall_resource',{skillId:7},'interrupt-uninstall');first.close();
      interrupted=await interruptedUpgrade(home,state,{rename:!uninstall,uninstall,afterOldMove:mode==='rename-after-old-move'});await killAtBarrier(interrupted);
      const journal=join(registryPath(home),'../transaction.json'),tx=JSON.parse(readFileSync(journal));assert.equal(existsSync(tx.backup),mode!=='rename-before-old-move');
      later=new ProxySession({home});const result=data(await later.request(call(2,'my_installed')));assert.equal(result.records[0].installedVersionId,1);assert.equal(readFileSync(join(old.directory,'SKILL.md'),'utf8'),oldBody);assert.equal(lstatSync(old.directory).ino,inode);
      if(!uninstall)assert.equal(existsSync(tx.next.directory),false);assert.equal(existsSync(journal),false);
      assert.equal(state.events.length,2);assert.equal(state.events.at(-1).requestId,tx.event.requestId);assert.equal(state.events.at(-1).errorCode,'INTERRUPTED');assert.equal(state.events.at(-1).success,false);
    }finally{first.close();interrupted?.close();later?.close();await stub.close();cleanup();}
  }
});

test('D-R3 改名后的旧路径整份复制v1带marker及owner，不能借new-name归属计成功',async()=>{
  const {home,cleanup}=makeHome(),{stub,state}=await platform();writeConfig(home,{url:stub.url,key:'fictional-r3-copy'});const proxy=new ProxySession({home});
  try{
    const old=data(await proxy.request(call(1,'install_resource',{skillId:7})));state.version=2;state.name='renamed-fixture';const next=data(await proxy.request(call(2,'install_resource',{skillId:7})));
    cpSync(next.backup,old.directory,{recursive:true});const body=loadedBody(old.directory);writeFileSync(join(old.directory,'user-note.txt'),'unmanaged historical path');
    await load(home,body,{name:'managed-fixture',callId:'copied-old-name'});console.log('D-R3 historical path',JSON.stringify({oldPath:old.directory,currentPath:next.directory,loads:state.loads}));
    assert.equal(state.loads.length,0);assert.equal(readFileSync(join(old.directory,'user-note.txt'),'utf8'),'unmanaged historical path');assert.equal(readRegistry(home).records['7'].versionId,2);
  }finally{proxy.close();await stub.close();cleanup();}
});

for(const rollback of [true,false])test(`D-R3 真v1 Post在新目录换入未登记窗口先持久化，${rollback?'回退':'提交'}后只报原v1`,async()=>{
  const {home,cleanup}=makeHome(),{stub,state}=await platform();writeConfig(home,{url:stub.url,key:'fictional-r3-window'});const first=new ProxySession({home});let interrupted,later,post;
  try{
    const old=data(await first.request(call(1,'install_resource',{skillId:7}))),body=loadedBody(old.directory),event={session_id:'real-old-before-switch',tool_name:'Skill',tool_input:{skill:'managed-fixture'},tool_use_id:'old-before-switch'};
    await runHookAsync('load.mjs',{...event,hook_event_name:'PreToolUse'},{home});first.close();
    interrupted=await interruptedUpgrade(home,state,{pause:'stop'});const scope=join(registryPath(home),'..'),journal=join(scope,'transaction.json'),tx=JSON.parse(readFileSync(journal));assert.equal(readRegistry(home).records['7'].versionId,1);assert.equal(lstatSync(old.directory).ino,tx.next.ino);
    post=runHookAsync('load.mjs',{...event,hook_event_name:'PostToolUse',tool_response:body},{home});
    const pendingDir=join(scope,'loads-pending');const appeared=new Promise((resolve,reject)=>{const w=watch(scope,{recursive:true},()=>{if(existsSync(pendingDir)&&readdirSync(pendingDir).length){w.close();resolve(true);}});setTimeout(()=>{w.close();reject(Error('load metadata not persisted before lock'));},2500).unref();});
    const persisted=await Promise.race([appeared,post.then(()=>false)]);
    console.log('D-R3 transaction window',JSON.stringify({rollback,registeredVersion:readRegistry(home).records['7'].versionId,txVersion:tx.next.versionId,persisted,loads:state.loads}));assert.equal(persisted,true);
    const files=readdirSync(pendingDir),pending=JSON.parse(readFileSync(join(pendingDir,files[0])));assert.doesNotMatch(JSON.stringify(pending),/Fixture release|tool_response|Base directory for this skill|fictional-r3-window/);
    if(rollback)await killAtBarrier(interrupted);else interrupted.child.kill('SIGCONT');
    await post;later=new ProxySession({home});data(await later.request(call(3,'my_installed')));
    assert.equal(state.loads.length,1);assert.equal(state.loads[0].versionId,1);assert.equal(state.loads[0].success,true);assert.equal(state.loads[0].requestId,files[0].slice(0,-5));assert.equal(state.downloads.length,2);assert.equal(readRegistry(home).records['7'].versionId,rollback?1:2);assert.equal(existsSync(journal),false);
  }finally{first.close();if(interrupted&&interrupted.child.exitCode===null&&interrupted.child.signalCode===null)await killAtBarrier(interrupted);later?.close();if(post)await post;await stub.close();cleanup();}
});

test('D-R3 正式v2在换入窗口实际返回，回退登记也不得把已识别v2降为unknown',async()=>{
  const {home,cleanup}=makeHome(),{stub,state}=await platform();writeConfig(home,{url:stub.url,key:'fictional-r3-next'});const first=new ProxySession({home});let interrupted,post,later;
  try{
    const old=data(await first.request(call(1,'install_resource',{skillId:7})));first.close();interrupted=await interruptedUpgrade(home,state,{pause:'stop'});
    const event={session_id:'new-before-rollback',tool_name:'Skill',tool_input:{skill:'managed-fixture'},tool_use_id:'new-before-rollback'},body=loadedBody(old.directory);
    assert.match(body,/Fixture release v2/);await runHookAsync('load.mjs',{...event,hook_event_name:'PreToolUse'},{home});
    const scope=join(registryPath(home),'..'),pendingDir=join(scope,'loads-pending');
    const ready=new Promise((resolve,reject)=>{const w=watch(scope,{recursive:true},()=>{if(existsSync(pendingDir)&&readdirSync(pendingDir).length){w.close();resolve();}});setTimeout(()=>{w.close();reject(Error('known v2 not persisted'));},2500).unref();});
    post=runHookAsync('load.mjs',{...event,hook_event_name:'PostToolUse',tool_response:body},{home});await ready;await killAtBarrier(interrupted);await post;
    later=new ProxySession({home});data(await later.request(call(2,'my_installed')));console.log('D-R3 new return then rollback',JSON.stringify({installedVersion:readRegistry(home).records['7'].versionId,loads:state.loads}));
    assert.equal(readRegistry(home).records['7'].versionId,1);assert.equal(state.loads.length,1);assert.equal(state.loads[0].versionId,2);assert.equal(state.loads[0].success,true);assert.equal(state.downloads.length,2);
  }finally{first.close();if(interrupted&&interrupted.child.exitCode===null&&interrupted.child.signalCode===null)await killAtBarrier(interrupted);later?.close();if(post)await post;await stub.close();cleanup();}
});

for(const [existing,postFirst]of [[true,false],[false,true],[false,false]])test(`D3-R3 ${existing?'升级':'首次安装'} ${postFirst?'identified先于回退':'recover先于Post'} 不丢真实正式v2`,async()=>{
  const {home,cleanup}=makeHome(),{stub,state}=await platform(),key='fictional-d3-only';writeConfig(home,{url:stub.url,key});const first=new ProxySession({home});let interrupted,post,later;
  try{
    let oldBody;if(existing){const old=data(await first.request(call(1,'install_resource',{skillId:7})));oldBody=readFileSync(join(old.directory,'SKILL.md'),'utf8');}first.close();
    interrupted=await interruptedUpgrade(home,state,{pause:'stop'});
    const scope=join(registryPath(home),'..'),journal=join(scope,'transaction.json'),tx=JSON.parse(readFileSync(journal)),dir=tx.next.directory,event={session_id:'d3-'+existing+'-'+postFirst,tool_name:'Skill',tool_input:{skill:'managed-fixture'},tool_use_id:'actual-v2-before-rollback'};
    assert.equal(tx.old!==null,existing);assert.equal(lstatSync(dir).ino,tx.next.ino);
    await runHookAsync('load.mjs',{...event,hook_event_name:'PreToolUse'},{home});const body=loadedBody(dir),binding=readStateFile(home,event.session_id).skillLoadBindings[event.tool_use_id];
    assert.match(body,/Fixture release v2/);assert.ok(body.includes(`<!-- promate-load:${tx.next.installationId} -->`));assert.equal(binding.sources[0].installationId,tx.next.installationId);assert.equal(binding.sources[0].ino,tx.next.ino);assert.equal(binding.sources[0].versionId,2);
    const requestId=hash(JSON.stringify({callId:event.tool_use_id,profile:join(home,'profile'),session:event.session_id,url:stub.url})),pendingDir=join(scope,'loads-pending');let saved;
    if(postFirst){
      const ready=new Promise((resolve,reject)=>{const w=watch(scope,{recursive:true},()=>{if(existsSync(join(pendingDir,requestId+'.json'))){w.close();resolve();}});setTimeout(()=>{w.close();reject(Error('identified not persisted'));},2500).unref();});
      post=runHookAsync('load.mjs',{...event,hook_event_name:'PostToolUse',tool_response:body},{home});await ready;saved=JSON.parse(readFileSync(join(pendingDir,requestId+'.json')));assert.equal(saved.metadata.identified[0].versionId,2);
    }
    state.reportFail=true;await killAtBarrier(interrupted);if(post)await post;
    later=new ProxySession({home});const listing=data(await later.request(call(3,'my_installed')));
    assert.equal(existsSync(journal),false);assert.equal(listing.records.length,existing?1:0);assert.equal(readRegistry(home).versions.some(v=>v.versionId===2),false);
    if(existing){assert.equal(readRegistry(home).records['7'].versionId,1);assert.equal(readFileSync(join(dir,'SKILL.md'),'utf8'),oldBody);}else{assert.deepEqual(readRegistry(home).records,{});assert.equal(existsSync(dir),false);}
    if(!postFirst)post=runHookAsync('load.mjs',{...event,hook_event_name:'PostToolUse',tool_response:body},{home});await post;
    const db=readRegistry(home),loads=db.queue.filter(x=>x.path==='loads');console.log('D3-R3 rollback chronology',JSON.stringify({existing,postFirst,sourceToken:binding.sources[0].installationId,sourceInode:binding.sources[0].ino,journalPresent:existsSync(journal),records:db.records,savedIdentified:saved?.metadata.identified,loads,stateLoads:state.loads,downloads:state.downloads.length}));
    assert.equal(loads.length,1);assert.deepEqual(loads[0].event,{skillId:7,versionId:2,requestId,success:true});assert.equal(loads[0].memberId,'fixture-member');assert.equal(readdirSync(pendingDir).filter(x=>x.endsWith('.json')).length,0);
    assert.equal(db.queue.filter(x=>x.path==='events'&&x.event.operation===(existing?'UPGRADE':'INSTALL')&&x.event.errorCode==='INTERRUPTED'&&x.event.success===false).length,1);
    assert.doesNotMatch(JSON.stringify([binding,saved,db.queue]),/Fixture release|tool_response|Base directory for this skill|fictional-d3-only/);
    state.reportFail=false;data(await later.request(call(4,'my_installed')));assert.deepEqual(state.loads,[loads[0].event]);assert.equal(readRegistry(home).queue.length,0);assert.equal(state.downloads.length,existing?2:1);assert.equal(state.events.filter(x=>x.success).length,existing?1:0);
  }finally{first.close();if(interrupted&&interrupted.child.exitCode===null&&interrupted.child.signalCode===null)await killAtBarrier(interrupted);later?.close();if(post)await post;await stub.close();cleanup();}
});

for(const replacement of [true,false])test(`D3-R3 可靠Pre后回退，${replacement?'复制owner新inode仍拒绝':'缺marker仍unknown失败而非猜正式版'}`,async()=>{
  const {home,cleanup}=makeHome(),{stub,state}=await platform();writeConfig(home,{url:stub.url,key:'fictional-d3-guard'});let interrupted,later;
  try{
    interrupted=await interruptedUpgrade(home,state,{pause:'stop'});const journal=join(registryPath(home),'../transaction.json'),tx=JSON.parse(readFileSync(journal)),dir=tx.next.directory,event={session_id:'d3-guard',tool_name:'Skill',tool_input:{skill:'managed-fixture'},tool_use_id:'guarded-return'};
    await runHookAsync('load.mjs',{...event,hook_event_name:'PreToolUse'},{home});const body=loadedBody(dir);cpSync(dir,join(home,'kept-fixture'),{recursive:true});
    await killAtBarrier(interrupted);later=new ProxySession({home});data(await later.request(call(1,'my_installed')));assert.equal(existsSync(dir),false);assert.equal(existsSync(journal),false);assert.deepEqual(readRegistry(home).records,{});
    if(replacement){cpSync(join(home,'kept-fixture'),dir,{recursive:true});writeFileSync(join(dir,'user-note.txt'),'unmanaged copy survives');assert.notEqual(lstatSync(dir).ino,tx.next.ino);}
    await runHookAsync('load.mjs',{...event,hook_event_name:'PostToolUse',tool_response:replacement?body:body.replace(/<!-- promate-load:[a-f0-9-]{36} -->/,'')},{home});
    if(replacement){assert.equal(state.loads.length,0);assert.equal(readFileSync(join(dir,'user-note.txt'),'utf8'),'unmanaged copy survives');}
    else {assert.equal(state.loads.length,1);assert.equal(state.loads[0].versionId,null);assert.equal(state.loads[0].success,false);assert.equal(state.loads[0].errorCode,'VERSION_UNKNOWN');}
    assert.equal(state.downloads.length,1);assert.equal(state.events.filter(x=>x.success).length,0);
  }finally{if(interrupted&&interrupted.child.exitCode===null&&interrupted.child.signalCode===null)await killAtBarrier(interrupted);later?.close();await stub.close();cleanup();}
});

test('S1/S2 实际标记区分新旧加载；失败及未知版本留痕，非平台技能不串报',async()=>{
  const {home,cleanup}=makeHome(),{stub,state}=await platform();writeConfig(home,{url:stub.url,key:'fictional-load-key'});const proxy=new ProxySession({home});
  try{
    const first=data(await proxy.request(call(1,'install_resource',{skillId:7}))),oldBody=loadedBody(first.directory);
    state.version=2;const upgraded=data(await proxy.request(call(2,'install_resource',{skillId:7}))),newBody=loadedBody(upgraded.directory);
    await load(home,oldBody,{callId:'old-cache'});await load(home,newBody,{callId:'new-cache'});
    assert.deepEqual(state.loads.map(x=>x.versionId),[1,2]);assert.equal(state.loads.every(x=>x.success),true);
    await load(home,'Error: Can not find skill: "managed-fixture"',{callId:'missing'});
    assert.equal(state.loads.at(-1).versionId,null);assert.equal(state.loads.at(-1).success,false);assert.equal(state.loads.at(-1).errorCode,'VERSION_UNKNOWN');
    const unknown=await load(home,`Base directory for this skill: ${upgraded.directory}\nUnidentifiable instructions`,{callId:'unknown'});
    assert.match(unknown.stdout,/归因失败/);assert.equal(state.loads.at(-1).versionId,null);
    const count=state.loads.length;await load(home,newBody.replace(upgraded.directory,join(home,'foreign-skill')),{callId:'foreign'});
    await load(home,'foreign instructions',{callId:'third-party',name:'non-platform'});assert.equal(state.loads.length,count);
    await load(home,oldBody,{callId:'exception',failure:true});assert.equal(state.loads.at(-1).versionId,1);assert.equal(state.loads.at(-1).errorCode,'LOAD_FAILED');
    await load(home,oldBody,{callId:'old-cache'});assert.equal(state.loads.at(-1).requestId,state.loads[0].requestId,'same original call stable id');
    assert.doesNotMatch(JSON.stringify(state.loads),/Fixture release|Base directory|promate-load|tool_response|memberId|source/);
    const beforeForeign=state.loads.length;renameSync(upgraded.directory,join(home,'held-owned-directory'));mkdirSync(upgraded.directory);writeFileSync(join(upgraded.directory,'SKILL.md'),newBody);
    await load(home,newBody,{callId:'replaced-directory'});assert.equal(state.loads.length,beforeForeign,'copied token in replaced non-owned directory must not report');
  }finally{proxy.close();await stub.close();cleanup();}
});

test('S3/L1 加载断网补报不重放；Skill 前后换Key不把旧事件送给新身份',async()=>{
  const {home,cleanup}=makeHome(),{stub,state}=await platform();writeConfig(home,{url:stub.url,key:'old-fictional-load-key'});const proxy=new ProxySession({home});
  try{
    const installed=data(await proxy.request(call(1,'install_resource',{skillId:7}))),body=loadedBody(installed.directory);
    state.reportFail=true;const offline=await load(home,body,{callId:'offline'});assert.match(offline.stdout,/暂存/);assert.equal(state.loads.length,0);
    state.reportFail=false;data(await proxy.request(call(2,'my_installed')));assert.equal(state.loads.length,1);assert.equal(state.downloads.length,1);
    const event={session_id:'switch-key',tool_name:'Skill',tool_input:{skill:'managed-fixture'},tool_use_id:'changing-key'};
    await runHookAsync('load.mjs',{...event,hook_event_name:'PreToolUse'},{home});
    writeConfig(home,{url:stub.url,key:'new-fictional-load-key'});state.member='new-fixture-member';
    const parked=await runHookAsync('load.mjs',{...event,hook_event_name:'PostToolUse',tool_response:body},{home});assert.match(parked.stdout,/暂存/);
    const pending=data(await proxy.request(call(3,'my_installed')));assert.equal(state.loads.length,1);assert.equal(pending.report.pending,1);
    writeConfig(home,{url:stub.url,key:'old-fictional-load-key'});state.member='fixture-member';
    const flushed=data(await proxy.request(call(4,'my_installed')));assert.equal(state.loads.length,2);assert.equal(flushed.report.pending,0);assert.equal(state.downloads.length,1);
  }finally{proxy.close();await stub.close();cleanup();}
});

test('C1/C2 九类写操作与旧别名全部独立确认，取消及一次后再调拒绝',async()=>{
  const {home,cleanup}=makeHome(),{stub}=await platform();writeConfig(home,{url:stub.url,key:'fictional-confirm-key'});const proxy=new ProxySession({home});
  try{
    data(await proxy.request(call(1,'install_resource',{skillId:7})));
    const cases={mark_done:{requirementId:13},mark_delivered:{requirementId:13},set_stage:{requirementId:13,stage:'DELIVERED'},add_artifact:{requirementId:13,title:'Fixture',artifactType:'DOC',documentUrl:'https://fixture.test/doc'},update_artifact:{requirementId:13,artifactId:3,title:'Changed'},remove_artifact:{requirementId:13,artifactId:3},retry_writeback:{outboxId:4},upload_skill:{name:'Fixture',category:'GENERAL',filePath:join(home,'fixture.md')},upload_skill_version:{skillId:7,version:'v2',filePath:join(home,'fixture.md')},uninstall_resource:{skillId:7}};
    for(const [name,input]of Object.entries(cases))for(const mode of ['default','bypassPermissions']){
      const session=`${name}-${mode}`,event={session_id:session,permission_mode:mode,tool_name:`mcp__promate__${name}`,tool_input:input};
      assert.equal(decision(await runHookAsync('confirm.mjs',event,{home})),'deny');runHook('route.mjs',{session_id:session,prompt:'取消'},{home});
      assert.equal(decision(await runHookAsync('confirm.mjs',event,{home})),'deny');runHook('route.mjs',{session_id:session,prompt:'确认'},{home});
      assert.equal(decision(await runHookAsync('confirm.mjs',event,{home})),'allow');assert.equal(decision(await runHookAsync('confirm.mjs',event,{home})),'deny');
    }
  }finally{proxy.close();await stub.close();cleanup();}
});

test('C1 retry 绑定具体任务目标；相同ID目标改变旧确认失效，不替换任务',async()=>{
  const {home,cleanup}=makeHome(),{stub,state}=await platform();writeConfig(home,{url:stub.url,key:'fictional-retry-key'});const proxy=new ProxySession({home});
  try{
    const input={outboxId:4},event={session_id:'retry-object',tool_name:'mcp__promate__retry_writeback',tool_input:input};
    const initial=await runHookAsync('confirm.mjs',event,{home});assert.match(initial.stdout,/重试任务 4/);runHook('route.mjs',{session_id:'retry-object',prompt:'确认'},{home});
    state.taskDone=false;assert.equal(decision(await runHookAsync('confirm.mjs',event,{home})),'deny');
    assert.equal((await proxy.request(call(1,'retry_writeback',input))).result.isError,true);
  }finally{proxy.close();await stub.close();cleanup();}
});

test('L1 未取得真实分发版失败用 VERSION_UNKNOWN 留痕，不能算当前版安装成功',async()=>{
  const {home,cleanup}=makeHome(),{stub,state}=await platform();writeConfig(home,{url:stub.url,key:'fictional-failed-download'});const proxy=new ProxySession({home});
  try{
    state.downloadFail=true;assert.equal((await proxy.request(call(1,'install_resource',{skillId:7}))).result.isError,true);
    assert.equal(state.events.length,1);assert.deepEqual({versionId:state.events[0].versionId,success:state.events[0].success,errorCode:state.events[0].errorCode},{versionId:null,success:false,errorCode:'VERSION_UNKNOWN'});
    assert.equal(data(await proxy.request(call(2,'my_installed'))).records.length,0);
  }finally{proxy.close();await stub.close();cleanup();}
});

test('U2 验证后文件再变仍只上传同份已确认bytes，不重读新文件',async()=>{
  const {home,cleanup}=makeHome(),{stub,state}=await platform();writeConfig(home,{url:stub.url,key:'fictional-exact-bytes'});
  const filePath=join(home,'fixture.md'),original=readFileSync(filePath),preload=join(home,'after-validation.cjs');
  writeFileSync(preload,`const fs=require('fs');const rename=fs.renameSync;fs.renameSync=function(a,b){const result=rename.apply(this,arguments);if(String(b).endsWith('/bytes-proof.json')&&!JSON.parse(fs.readFileSync(b)).approvedCall)fs.writeFileSync(${JSON.stringify(filePath)},'modified-after-validation');return result;};require('module').syncBuiltinESMExports();`);
  const proxy=new ProxySession({home,env:{NODE_OPTIONS:`--require=${preload}`}});
  try{
    const input={name:'Fixture',category:'GENERAL',filePath};await approve(home,'upload_skill',input,'bytes-proof');data(await proxy.request(call(1,'upload_skill',input)));
    assert.equal(readFileSync(filePath,'utf8'),'modified-after-validation');assert.deepEqual(Buffer.from(state.uploads[0].args.contentBase64,'base64'),original);
  }finally{proxy.close();await stub.close();cleanup();}
});

test('C1 所有写调用代理再核验一次；换Key／原Key回写也不能复活旧确认',async()=>{
  const {home,cleanup}=makeHome(),{stub,state}=await platform();writeConfig(home,{url:stub.url,key:'first-fictional-key'});const proxy=new ProxySession({home});
  try{
    const input={requirementId:13};assert.equal((await proxy.request(call(1,'mark_delivered',input))).result.isError,true);assert.equal(state.writes.length,0);
    await approve(home,'mark_delivered',input,'write-epoch');writeConfig(home,{url:stub.url,key:'changed-fictional-key'});
    assert.equal((await proxy.request(call(2,'mark_delivered',input))).result.isError,true);writeConfig(home,{url:stub.url,key:'first-fictional-key'});
    assert.equal((await proxy.request(call(3,'mark_delivered',input))).result.isError,true);assert.equal(state.writes.length,0);
    await approve(home,'mark_delivered',input,'new-write-epoch');data(await proxy.request(call(4,'mark_delivered',input)));
    assert.deepEqual(state.writes,[{name:'mark_delivered',args:input}]);assert.equal((await proxy.request(call(5,'mark_delivered',input))).result.isError,true);
  }finally{proxy.close();await stub.close();cleanup();}
});

test('S1 原已装md传新版本携旧尾标记时只换本机元数据，不混旧版或更改原包摘要',async()=>{
  const {home,cleanup}=makeHome(),{stub,state}=await platform();writeConfig(home,{url:stub.url,key:'fictional-old-footer'});const proxy=new ProxySession({home});
  try{
    const first=data(await proxy.request(call(1,'install_resource',{skillId:7})));state.sourceFooter=readFileSync(join(first.directory,'SKILL.md'),'utf8').match(/\n<!-- promate-load:[a-f0-9-]{36} -->\n$/)[0];state.version=2;
    const next=data(await proxy.request(call(2,'install_resource',{skillId:7}))),body=loadedBody(next.directory);assert.ok(!body.includes(state.sourceFooter.trim()));assert.equal([...body.matchAll(/promate-load:/g)].length,1);
    await load(home,body,{callId:'clean-footer'});assert.equal(state.loads[0].versionId,2);assert.equal(state.loads[0].success,true);
    const registry=JSON.parse(readFileSync(join(home,'resources',readdirSync(join(home,'resources'))[0],'installed.json')));assert.equal(registry.records['7'].sha256,hash(Buffer.from(text(state.name,'v2')+state.sourceFooter)));assert.equal(registry.records['7'].files['SKILL.md'],hash(readFileSync(join(next.directory,'SKILL.md'))));
  }finally{proxy.close();await stub.close();cleanup();}
});

test('本地安装／列表元数据也脱敏托管Key，不把源码或正文送统计接口',async()=>{
  const {home,cleanup}=makeHome(),{stub,state}=await platform(),key='fictional-local-metadata-key';writeConfig(home,{url:stub.url,key});state.label=key;const proxy=new ProxySession({home});
  try{const installed=await proxy.request(call(1,'install_resource',{skillId:7})),list=await proxy.request(call(2,'my_installed'));data(installed);data(list);assert.ok(!JSON.stringify([installed,list]).includes(key));assert.doesNotMatch(JSON.stringify(state.events),/Base directory|Fixture release|contentBase64|promate-load|memberId|credential/);}
  finally{proxy.close();await stub.close();cleanup();}
});

test('L1 同一原成员的新Key可补旧回报；仍按原平台/profile，不重装',async()=>{
  const {home,cleanup}=makeHome(),{stub,state}=await platform();writeConfig(home,{url:stub.url,key:'original-fictional-key'});const proxy=new ProxySession({home});
  try{
    state.reportFail=true;data(await proxy.request(call(1,'install_resource',{skillId:7})));assert.equal(state.events.length,0);
    state.reportFail=false;writeConfig(home,{url:stub.url,key:'rotated-fictional-key'});
    const reported=data(await proxy.request(call(2,'my_installed')));assert.equal(reported.report.pending,0);assert.equal(state.events.length,1);assert.equal(state.downloads.length,1);
  }finally{proxy.close();await stub.close();cleanup();}
});

test('L1/K3 下载未知失败后同号取原正式版，不冒充后来发布版；已知本机失败结束操作',async()=>{
  const {home,cleanup}=makeHome(),{stub,state}=await platform();writeConfig(home,{url:stub.url,key:'fixed-download-fictional-key'});const proxy=new ProxySession({home});
  try{
    state.downloadFail=true;assert.equal((await proxy.request(call(1,'install_resource',{skillId:7}))).result.isError,true);
    state.version=2;state.downloadFail=false;const resumed=data(await proxy.request(call(2,'install_resource',{skillId:7})));
    assert.equal(resumed.installedVersionId,1);assert.equal(resumed.latestStatus,'unknown');assert.equal(state.downloads[0],state.downloads[1]);
    const current=data(await proxy.request(call(3,'my_installed')));assert.equal(current.records[0].canUpgrade,true);
    state.tamper=true;assert.equal((await proxy.request(call(4,'install_resource',{skillId:7}))).result.isError,true);const failed=state.downloads.at(-1);
    state.version=3;state.tamper=false;const updated=data(await proxy.request(call(5,'install_resource',{skillId:7})));assert.equal(updated.installedVersionId,3);assert.notEqual(state.downloads.at(-1),failed,'new active operation after known local failure');
  }finally{proxy.close();await stub.close();cleanup();}
});
