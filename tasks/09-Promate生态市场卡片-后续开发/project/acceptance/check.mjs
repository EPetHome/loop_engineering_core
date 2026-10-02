// Direct Pi program/host checks. Historical Loop gates are not an execution prerequisite.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const [mode, codeArg, workspaceArg, ...options] = process.argv.slice(2);
assert.ok(['a','b','c','resources','preflight','host'].includes(mode));
assert.ok(options.every(option => mode === 'host' && option === '--technical-probe'), '未知检查选项');
const code = resolve(codeArg), workspace = resolve(workspaceArg);
mkdirSync(workspace, {recursive:true});
const root = mkdtempSync('/private/tmp/loop-card-check-');
const feature = join(code, 'experiments/ecosystem-cards');
const put = (file, data) => {mkdirSync(resolve(file,'..'),{recursive:true});writeFileSync(file,JSON.stringify(data));};
const json = file => JSON.parse(readFileSync(file,'utf8'));
const within = (parent, file) => {const part=relative(parent,file);assert.ok(part && !part.startsWith('..') && !isAbsolute(part));};
const files = dir => readdirSync(dir,{withFileTypes:true}).flatMap(e => {
  const path=join(dir,e.name);assert.ok(!lstatSync(path).isSymbolicLink());
  return e.isDirectory()?files(path):[path];
});
const input = {ownerId:'loop-card-acceptance',marketName:'loop-promate-test',
  card:{resourceId:'probe-001',name:'Loop 测试卡片',description:'隔离验证，不含业务内容',version:'1.0.0'}};

async function checkA() {
  const {generateMarket} = await import(pathToFileURL(join(feature,'card-generation/index.mjs')));
  assert.equal(typeof generateMarket,'function');
  const outputRoot=join(root,'generated');mkdirSync(outputRoot);
  const first=await generateMarket({...input,outputRoot});
  within(realpathSync(outputRoot),realpathSync(first.marketRoot));
  assert.equal(first.marketName,input.marketName);assert.equal(first.resourceId,input.card.resourceId);
  const manifest=json(join(first.marketRoot,'.codebuddy-plugin/marketplace.json'));
  assert.equal(manifest.name,input.marketName);assert.equal(manifest.plugins.length,1);
  const entry=manifest.plugins[0];assert.equal(entry.name,first.pluginName);
  assert.match(entry.name,/^[A-Za-z0-9][-A-Za-z0-9._]*$/,'目录安装器要求合法原生名称');
  assert.equal(entry.displayName,input.card.name,'只验证输入名称元数据，不推断原生标题支持 displayName');
  assert.equal(typeof entry.source,'string');assert.ok(entry.source.startsWith('./'));
  const pluginRoot=resolve(first.marketRoot,entry.source);within(realpathSync(first.marketRoot),realpathSync(pluginRoot));
  const plugin=json(join(pluginRoot,'.codebuddy-plugin/plugin.json'));
  assert.equal(plugin.name,first.pluginName);assert.equal(plugin.displayName,input.card.name);assert.equal(plugin.version,'1.0.0');
  assert.equal(plugin.description,input.card.description);
  assert.deepEqual(files(pluginRoot).map(p=>relative(pluginRoot,p)),['.codebuddy-plugin/plugin.json']);
  const again=await generateMarket({...input,outputRoot});
  assert.equal(again.pluginName,first.pluginName);assert.equal(again.marketRoot,first.marketRoot);
  const next=await generateMarket({...input,outputRoot,card:{...input.card,version:'1.0.1'}});
  assert.equal(next.pluginName,first.pluginName);assert.equal(next.marketRoot,first.marketRoot);
  assert.equal(json(join(pluginRoot,'.codebuddy-plugin/plugin.json')).version,'1.0.1');
  assert.equal(json(join(pluginRoot,'.codebuddy-plugin/plugin.json')).name,first.pluginName);
  assert.equal(json(join(pluginRoot,'.codebuddy-plugin/plugin.json')).displayName,input.card.name);
  assert.equal(json(join(first.marketRoot,'.codebuddy-plugin/marketplace.json')).plugins.length,1);
  await assert.rejects(async()=>generateMarket({...input,outputRoot,ownerId:'different-owner'}));
  await assert.rejects(async()=>generateMarket({...input,outputRoot,marketName:'../outside'}));
  console.log('PASS A（程序检查）：空壳内容、名称元数据、稳定身份、升级与归属保护；不证明中文标题展示');
}

async function checkB() {
  const {readCardState} = await import(pathToFileURL(join(feature,'card-state/index.mjs')));
  assert.equal(typeof readCardState,'function');
  const profile=join(root,'profile'),marketRoot=join(root,'market'),pluginName='loop-card-probe';
  mkdirSync(profile);mkdirSync(marketRoot);
  const args={profile,marketName:input.marketName,pluginName},id=`${pluginName}@${input.marketName}`;
  const empty=await readCardState(args);assert.equal(empty.installed,false);
  const pluginPath=join(profile,'plugins/cache',input.marketName,pluginName,'1.0.0');
  put(join(pluginPath,'.codebuddy-plugin/plugin.json'),{name:pluginName,version:'1.0.0',description:input.card.description});
  put(join(marketRoot,'.codebuddy-plugin/marketplace.json'),{name:input.marketName,plugins:[{name:pluginName,source:'./plugins/'+pluginName,version:'1.0.0'}]});
  put(join(profile,'plugins/known_marketplaces.json'),{[input.marketName]:{source:{source:'directory',path:marketRoot},installLocation:marketRoot,manifestName:input.marketName,lastUpdated:'2026-10-01T00:00:00Z'}});
  put(join(profile,'plugins/installed_plugins.json'),{version:2,plugins:{[id]:[{scope:'user',installPath:pluginPath,version:'1.0.0',installedAt:'2026-10-01T00:00:00Z',lastUpdated:'2026-10-01T00:00:00Z'}]}});
  put(join(profile,'settings.json'),{enabledPlugins:{[id]:true}});
  const before=files(profile).map(p=>[p,readFileSync(p).toString('base64')]);
  const on=await readCardState(args);assert.equal(on.marketRegistered,true);assert.equal(on.installed,true);assert.equal(on.enabled,true);assert.equal(on.version,'1.0.0');
  assert.deepEqual(files(profile).map(p=>[p,readFileSync(p).toString('base64')]),before);
  put(join(profile,'settings.json'),{enabledPlugins:{[id]:false}});
  const off=await readCardState(args);assert.equal(off.installed,true);assert.equal(off.enabled,false);
  put(join(profile,'plugins/installed_plugins.json'),{version:2,plugins:{}});
  assert.equal((await readCardState(args)).installed,false);
  writeFileSync(join(profile,'plugins/installed_plugins.json'),'{broken');
  let invalid;
  try {invalid=await readCardState(args);} catch {invalid={installed:null,reason:'rejected'};}
  assert.equal(invalid.installed,null);assert.ok(invalid.reason);
  console.log('PASS B：未安装、启用、停用、卸载、异常记录与只读性');
}


async function checkResources() {
  const {foreignResources,fingerprint,assessResourceProtection} = await import(pathToFileURL(join(feature,'integration/evidence.mjs')));
  const {generateMarket} = await import(pathToFileURL(join(feature,'card-generation/index.mjs')));
  const isolationRoot=join(root,'resources-isolation');mkdirSync(isolationRoot,{mode:0o700});
  const profile=join(isolationRoot,'profile');mkdirSync(profile,{mode:0o700});
  const marketName=input.marketName, pluginName='target-card', id=`${pluginName}@${marketName}`;
  let sourceProtection=null;
  const snapshot=()=>foreignResources(profile,marketName,pluginName,sourceProtection);
  const empty=snapshot();assert.match(empty.digest,/^[a-f0-9]{64}$/);
  const knownFile=join(profile,'plugins/known_marketplaces.json');
  const registryFile=join(profile,'plugins/installed_plugins.json');
  const settingsFile=join(profile,'settings.json');
  const known={[marketName]:{source:{source:'directory',path:join(root,'own-market')}}};
  const installed={version:2,plugins:{[id]:[{scope:'user',version:'1.0.0',installPath:join(profile,'plugins/cache',marketName,pluginName,'1.0.0')}]}};
  const settings={enabledPlugins:{[id]:true},extraKnownMarketplaces:{[marketName]:{source:{source:'directory',path:join(root,'own-market')}}}};
  put(knownFile,known);put(registryFile,installed);put(settingsFile,settings);
  put(join(profile,'plugins/cache',marketName,pluginName,'1.0.0/.codebuddy-plugin/plugin.json'),{name:pluginName,version:'1.0.0'});
  assert.equal(snapshot().digest,empty.digest,'仅目标安装及空容器初始化，不应误报其他资源变化');
  const other=await generateMarket({outputRoot:join(isolationRoot,'non-target-generated'),ownerId:input.ownerId,marketName:'unrelated-market',
    card:{...input.card,resourceId:'non-target-source-fixture',version:'3.0.0'}});
  const isolationToken='owned-acceptance-source-fixture';writeFileSync(join(isolationRoot,'.owner'),isolationToken,{mode:0o600});
  sourceProtection={isolationRoot,isolationToken,ownerId:input.ownerId,market:other,ownership:json(join(other.marketRoot,'.loop-card-owner.json'))};
  const foreignId=`${other.pluginName}@${other.marketName}`;
  known[other.marketName]={source:{source:'directory',path:other.marketRoot}};
  const cache=join(profile,'plugins/cache',other.marketName,other.pluginName,'3.0.0');
  installed.plugins[foreignId]=[{scope:'user',version:'3.0.0',installPath:cache}];
  settings.enabledPlugins[foreignId]=true;
  put(knownFile,known);put(registryFile,installed);put(settingsFile,settings);
  const foreignFile=join(cache,'.codebuddy-plugin/plugin.json');
  put(foreignFile,{name:other.pluginName,version:'3.0.0'});
  const before=snapshot().digest;assert.notEqual(before,empty.digest,'非目标资源必须进入比较');
  settings.enabledPlugins[id]=false;put(settingsFile,settings);
  assert.equal(snapshot().digest,before,'目标停用不能影响非目标摘要');
  settings.enabledPlugins[foreignId]=false;put(settingsFile,settings);
  assert.notEqual(snapshot().digest,before,'非目标启停变化必须检出');
  settings.enabledPlugins[foreignId]=true;put(settingsFile,settings);
  assert.equal(snapshot().digest,before,'恢复非目标状态后摘要应恢复');
  put(foreignFile,{name:other.pluginName,version:'3.0.1'});
  assert.notEqual(snapshot().digest,before,'非目标缓存文件变化必须检出');
  put(foreignFile,{name:other.pluginName,version:'3.0.0'});
  const sourceBefore=snapshot(), profileBefore=fingerprint(profile);
  const sourceFile=join(other.marketRoot,'plugins',other.pluginName,'.codebuddy-plugin/plugin.json'), sourceBytes=readFileSync(sourceFile);
  put(sourceFile,{...JSON.parse(sourceBytes),description:'只修改非目标市场源文件简介'});
  const sourceAfter=snapshot();assert.notEqual(sourceAfter.digest,sourceBefore.digest,'非目标源文件变化必须检出');
  assert.deepEqual(fingerprint(profile),profileBefore,'反例不得改变 profile/缓存/登记');
  put(join(workspace,'resources-source-fixture.json'),{scope:'temporary filesystem fixture ONLY; NOT native host evidence',
    sourceProtection,before:sourceBefore,after:sourceAfter,profileUnchanged:true});
  writeFileSync(sourceFile,sourceBytes);assert.equal(snapshot().digest,sourceBefore.digest);
  const added=join(other.marketRoot,'package-added.txt');writeFileSync(added,'fixture',{mode:0o600});
  const withAdded=snapshot().digest;assert.notEqual(withAdded,sourceBefore.digest);rmSync(added);
  assert.notEqual(snapshot().digest,withAdded);assert.equal(snapshot().digest,sourceBefore.digest);
  const protection=assessResourceProtection({before:sourceBefore,after:sourceBefore,nonTargetBaselineConfirmed:true});
  assert.equal(protection.protectedSourceBaselineConfirmed,true);assert.equal(protection.status,'UNKNOWN','未执行七步不能 PASS');
  rmSync(other.marketRoot,{recursive:true});assert.throws(snapshot,/ENOENT/,'非目标源目录丢失不得比较通过');
  console.log('PASS resources：目标变化不误报，非目标缓存/登记/启停及归属源文件增删改能检出，源目录丢失拒绝比较');
}

try {
if(mode==='a'||mode==='c')await checkA();
if(mode==='b'||mode==='c')await checkB();
if(mode==='resources'||mode==='c')await checkResources();
if(mode==='host'||mode==='preflight') {
  // Execute the real core checks against this exact code snapshot; never synthesize a gate receipt.
  const {fingerprint,sha,assessResourceProtection}=await import(pathToFileURL(join(feature,'integration/evidence.mjs')));
  const before=fingerprint(code), candidateDigest=sha(JSON.stringify(before));
  const coreArgs=[fileURLToPath(import.meta.url),'c',code,join(workspace,'core')], startedAt=new Date().toISOString();
  const core=spawnSync(process.execPath,coreArgs,{cwd:code,encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024});
  writeFileSync(join(workspace,'core.stdout.log'),core.stdout||'');writeFileSync(join(workspace,'core.stderr.log'),core.stderr||'');
  const candidateUnchanged=JSON.stringify(fingerprint(code))===JSON.stringify(before);
  put(join(workspace,'core-result.json'),{status:core.status===0&&!core.error&&!core.signal&&candidateUnchanged?'PASS':'FAIL',
    scope:'program-check-only',candidateCodeRoot:code,candidateDigest,candidateUnchanged,
    executable:process.execPath,args:coreArgs,exitCode:core.status,signal:core.signal,error:core.error?.message,
    startedAt,finishedAt:new Date().toISOString()});
  assert.ok(!core.error&&!core.signal&&core.status===0&&candidateUnchanged,'CORE_CHECKS_FAILED；不进入宿主流程');
  if(mode==='host')assert.ok(options.includes('--technical-probe'),'NAME_SCHEME_UNCONFIRMED；产品名称待确认，仅可显式运行技术探针');
  const reportPath=join(workspace,mode==='preflight'?'preflight-result.json':'host-result.json');
  const args=[join(feature,'integration/index.mjs'),'--workspace',workspace,'--report',reportPath];
  if(mode==='preflight')args.push('--preflight-only');
  if(mode==='host')args.push('--technical-probe');
  const child=spawnSync(process.execPath,args,{cwd:code,encoding:'utf8',timeout:mode==='preflight'?600000:900000,maxBuffer:8*1024*1024});
  writeFileSync(join(workspace,'host.stdout.log'),child.stdout||'');writeFileSync(join(workspace,'host.stderr.log'),child.stderr||'');
  console.log(JSON.stringify({mode,reportPath,exitCode:child.status,signal:child.signal,error:child.error?.message}));
  if(child.error||child.signal||child.status!==0){console.error('HOST_CHECK_INCOMPLETE='+mode);throw Error('宿主验证未完成，原始报告与输出已保留');}
  const report=json(reportPath);
  assert.equal(report.candidateCodeRoot,code);assert.equal(report.status,'PASS');
  assert.equal(report.candidateDigest,candidateDigest,'宿主受测副本必须与核心检查相同');
  assert.equal(report.candidateUnchanged,true);assert.equal(report.hostBuildUnchanged,true);
  assert.ok(report.hostVersion);assert.ok(report.profile && report.profile.startsWith('/private/tmp/loop-card-'));
  assert.equal(report.boundary?.pass,true);assert.equal(report.managedProcessesStopped,true);
  const evidence=[];
  function recordEvidence(path,png=false) {
    assert.equal(typeof path,'string');assert.ok(isAbsolute(path));
    within(workspace,resolve(path));within(realpathSync(workspace),realpathSync(path));
    assert.ok(!lstatSync(path).isSymbolicLink());
    const bytes=readFileSync(path);assert.ok(bytes.length);
    if(png)assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
    evidence.push({path,sha256:createHash('sha256').update(bytes).digest('hex')});
  }
  if(mode==='preflight') {
    assert.equal(report.mode,'preflight');
    for(const field of ['profileIsolated','nativeProtectionRetained','marketPanelVisible'])assert.equal(report.preflight?.[field],true,field);
    assert.ok(Array.isArray(report.steps) && report.steps.every(s=>s.attempted===false),'预检不得执行安装等业务步骤');
    recordEvidence(report.preflight.rawEvidencePath);recordEvidence(report.preflight.screenshotPath,true);
  } else {
    assert.equal(report.otherResourcesUnchanged,true);assert.equal(report.nonTargetBaselineConfirmed,true);
    recordEvidence(report.nonTargetFixture.rawEvidencePath);
    assert.equal(report.resourceProtection?.ownedNonTargetBaselineConfirmed,true);
    const baseline=json(report.nonTargetFixture.rawEvidencePath);
    assert.equal(baseline.confirmed,true);assert.equal(baseline.registrationOutput?.success,true);assert.equal(baseline.installOutput?.success,true);
    assert.equal(baseline.state?.marketRegistered,true);assert.equal(baseline.state?.installed,true);
    assert.equal(baseline.state?.enabled,true);assert.equal(baseline.state?.version,'1.0.0');
    assert.notEqual(baseline.market?.marketName,report.market.marketName);assert.notEqual(baseline.market?.pluginName,report.market.pluginName);
    const sourceProtection=baseline.sourceProtection;
    assert.equal(sourceProtection?.isolationRoot,report.isolationRoot);assert.equal(report.profile,join(report.isolationRoot,'profile'));
    assert.equal(sourceProtection.isolationToken,report.recovery?.ownerToken);assert.equal(sourceProtection.ownerId,report.ownerId);
    assert.deepEqual(sourceProtection.market,baseline.market);
    assert.equal(baseline.market.marketRoot,join(report.isolationRoot,'non-target-generated',baseline.market.marketName));
    const ownership=sourceProtection.ownership;assert.equal(ownership?.format,1);assert.equal(ownership.ownerId,report.ownerId);
    for(const key of ['marketName','pluginName','resourceId'])assert.equal(ownership[key],baseline.market[key]);
    const foreignPaths=['foreign-before.json','foreign-after.json'].map(name=>join(report.evidenceRoot,name));
    for(const path of foreignPaths)recordEvidence(path);
    const [foreignBefore,foreignAfter]=foreignPaths.map(json);
    for(const snapshot of [foreignBefore,foreignAfter])assert.equal(snapshot.digest,sha(JSON.stringify(snapshot.value)),'原始快照摘要须对应完整值');
    assert.equal(baseline.baselineDigest,foreignBefore.digest);assert.equal(foreignAfter.digest,foreignBefore.digest);
    const protectedSources=foreignBefore.value.sources;assert.equal(protectedSources?.length,1);
    const source=protectedSources[0];assert.equal(source.marketRoot,baseline.market.marketRoot);assert.equal(source.isolationRoot,report.isolationRoot);
    assert.equal(source.ownerId,report.ownerId);
    for(const key of ['marketName','pluginName','resourceId'])assert.equal(source[key],baseline.market[key]);
    assert.deepEqual(source.expectedFiles,ownership.files);assert.deepEqual(foreignAfter.value.sources,protectedSources);
    const protection=assessResourceProtection({steps:report.steps,before:foreignBefore,after:foreignAfter,nonTargetBaselineConfirmed:report.nonTargetBaselineConfirmed});
    assert.equal(protection.status,'PASS');assert.equal(protection.protectedSourceBaselineConfirmed,true);assert.equal(protection.protectedSourceSetConfirmed,true);
    assert.deepEqual(report.resourceProtection,protection);
    const protectionPath=join(report.evidenceRoot,'resource-protection.json');recordEvidence(protectionPath);assert.deepEqual(json(protectionPath),protection);
    const {targetVersionEvidenceMatches}=await import(pathToFileURL(join(feature,'integration/target-version.mjs')));
    assert.equal(report.verificationScope,'native-ascii-technical-probe');assert.equal(report.businessAcceptance,'NOT_VERIFIED');
    assert.equal(report.expectedTitle,report.market.pluginName);assert.match(report.expectedTitle,/^[A-Za-z0-9][-A-Za-z0-9._]*$/);
    assert.equal(report.steps.length,7);assert.equal(report.card?.name,'Loop 空壳卡片');
    assert.equal(report.card?.resourceId,'loop-ecology-shell-probe');assert.equal(report.card?.version,'1.0.0');
    const screenshots=new Set();
    for(const action of ['market-visible','install','disable','enable','uninstall','reinstall','upgrade']) {
      const matching=report.steps.filter(s=>s.action===action);assert.equal(matching.length,1,action);
      const step=matching[0];assert.equal(step.attempted,true,action);assert.equal(step.status,'PASS',action);
      assert.equal(step.foreignResourcesUnchanged,true,action);
      recordEvidence(step.rawEvidencePath);recordEvidence(step.screenshotPath,true);screenshots.add(realpathSync(step.screenshotPath));
      const raw=json(step.rawEvidencePath);assert.equal(raw.action,action);assert.equal(raw.attempted,true);assert.equal(raw.status,'PASS');
      assert.equal(raw.nameVerification?.expected,report.expectedTitle);assert.equal(raw.nameVerification?.correct,true);
      assert.equal(raw.nameVerification?.scope,report.verificationScope);
      assert.ok(raw.nameVerification?.titles?.includes(report.expectedTitle),'技术探针亦须核对真实原生标题');
      assert.equal(targetVersionEvidenceMatches(raw.versionVerification,{pluginName:report.market.pluginName,marketName:report.market.marketName,
        expectedVersion:action==='upgrade'?'1.0.1':'1.0.0',scope:report.verificationScope}),true,'版本必须来自唯一可见目标的精确字段，含定位依据');
      assert.equal(raw.foreignResourcesUnchanged,true);assert.equal(raw.foreign?.digest,foreignBefore.digest);
      assert.equal(raw.foreign.digest,sha(JSON.stringify(raw.foreign.value)));
      assert.deepEqual(raw.foreign.value.sources,protectedSources,'准备/每步/退出必须保护同一个归属源目录及文件');
      assert.deepEqual(raw.nonTargetState,baseline.state,'本步非目标测试资源状态必须保留');
      assert.equal(raw.state?.marketRegistered,true);
      if(['market-visible','uninstall'].includes(action))assert.equal(raw.state?.installed,false);
      else {assert.equal(raw.state?.installed,true);assert.equal(raw.state?.enabled,action!=='disable');assert.equal(raw.state?.version,action==='upgrade'?'1.0.1':'1.0.0');}
    }
    assert.equal(screenshots.size,7,'七步必须分别留截图，不复用截图路径');
  }
  console.log(JSON.stringify({hostReport:reportPath,reportSha256:createHash('sha256').update(readFileSync(reportPath)).digest('hex'),evidence}));
  console.log('PASS '+mode+'：'+(mode==='host'?'仅 ASCII 技术探针，不代表产品名称/业务验收；':'')+'原生操作、截图及保护真实性仍须独立复核。');
}
} finally { rmSync(root,{recursive:true,force:true}); }

