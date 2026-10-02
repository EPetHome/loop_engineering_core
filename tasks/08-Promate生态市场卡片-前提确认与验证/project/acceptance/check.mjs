// Frozen acceptance: candidate modules run in temporary directories, never the user's profile.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const [mode, codeArg, workspaceArg] = process.argv.slice(2);
assert.ok(['a','b','c','resources','preflight','host'].includes(mode));
const code = resolve(codeArg), workspace = resolve(workspaceArg);
mkdirSync(workspace, {recursive:true});
const root = mkdtempSync(join(tmpdir(), 'loop-card-check-'));
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
  assert.equal(entry.name,input.card.name,'原生列表读取 name；displayName 不能代替输入名称');
  assert.equal(typeof entry.source,'string');assert.ok(entry.source.startsWith('./'));
  const pluginRoot=resolve(first.marketRoot,entry.source);within(realpathSync(first.marketRoot),realpathSync(pluginRoot));
  const plugin=json(join(pluginRoot,'.codebuddy-plugin/plugin.json'));
  assert.equal(plugin.name,first.pluginName);assert.equal(plugin.name,input.card.name);assert.equal(plugin.version,'1.0.0');
  assert.equal(plugin.description,input.card.description);
  assert.deepEqual(files(pluginRoot).map(p=>relative(pluginRoot,p)),['.codebuddy-plugin/plugin.json']);
  const again=await generateMarket({...input,outputRoot});
  assert.equal(again.pluginName,first.pluginName);assert.equal(again.marketRoot,first.marketRoot);
  const next=await generateMarket({...input,outputRoot,card:{...input.card,version:'1.0.1'}});
  assert.equal(next.pluginName,first.pluginName);assert.equal(next.marketRoot,first.marketRoot);
  assert.equal(json(join(pluginRoot,'.codebuddy-plugin/plugin.json')).version,'1.0.1');
  assert.equal(json(join(pluginRoot,'.codebuddy-plugin/plugin.json')).name,input.card.name);
  assert.equal(json(join(first.marketRoot,'.codebuddy-plugin/marketplace.json')).plugins.length,1);
  await assert.rejects(async()=>generateMarket({...input,outputRoot,ownerId:'different-owner'}));
  await assert.rejects(async()=>generateMarket({...input,outputRoot,marketName:'../outside'}));
  console.log('PASS A：空壳内容、稳定身份、重复生成、升级与归属保护');
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
  const {foreignResources} = await import(pathToFileURL(join(feature,'integration/evidence.mjs')));
  const profile=join(root,'foreign-profile');mkdirSync(profile);
  const marketName=input.marketName, pluginName='target-card', id=`${pluginName}@${marketName}`;
  const snapshot=()=>foreignResources(profile,marketName,pluginName);
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
  const foreignId='unrelated-card@unrelated-market';
  known['unrelated-market']={source:{source:'directory',path:join(root,'foreign-market')}};
  installed.plugins[foreignId]=[{scope:'user',version:'3.0.0',installPath:join(profile,'plugins/cache/unrelated-market/unrelated-card/3.0.0')}];
  settings.enabledPlugins[foreignId]=true;
  put(knownFile,known);put(registryFile,installed);put(settingsFile,settings);
  const foreignFile=join(profile,'plugins/cache/unrelated-market/unrelated-card/3.0.0/.codebuddy-plugin/plugin.json');
  put(foreignFile,{name:'unrelated-card',version:'3.0.0'});
  const before=snapshot().digest;assert.notEqual(before,empty.digest,'非目标资源必须进入比较');
  settings.enabledPlugins[id]=false;put(settingsFile,settings);
  assert.equal(snapshot().digest,before,'目标停用不能影响非目标摘要');
  settings.enabledPlugins[foreignId]=false;put(settingsFile,settings);
  assert.notEqual(snapshot().digest,before,'非目标启停变化必须检出');
  settings.enabledPlugins[foreignId]=true;put(settingsFile,settings);
  assert.equal(snapshot().digest,before,'恢复非目标状态后摘要应恢复');
  put(foreignFile,{name:'unrelated-card',version:'3.0.1'});
  assert.notEqual(snapshot().digest,before,'非目标文件变化必须检出');
  console.log('PASS resources：目标初始化不误报，非目标状态和文件变化能检出');
}

if(mode==='a'||mode==='c')await checkA();
if(mode==='b'||mode==='c')await checkB();
if(mode==='resources'||mode==='c')await checkResources();
if(mode==='host'||mode==='preflight') {
  // The engine executes gates in declaration order; bind the host guard to this exact round.
  if(mode==='host') {
    assert.match(basename(workspace),/^r[0-9]+-G2$/,'G2 must be invoked by Loop');
    const previous=join(dirname(workspace),basename(workspace).replace(/-G2$/,'-G1'),'evidence.json');
    assert.equal(json(previous).status,'PASS','本轮 G1 未通过，不启动真实七步');
  }
  const reportPath=join(workspace,mode==='preflight'?'preflight-result.json':'host-result.json');
  const args=[join(feature,'integration/index.mjs'),'--workspace',workspace,'--report',reportPath];
  if(mode==='preflight')args.push('--preflight-only');
  const child=spawnSync(process.execPath,args,{cwd:code,encoding:'utf8',timeout:mode==='preflight'?600000:900000,maxBuffer:8*1024*1024});
  writeFileSync(join(workspace,'host.stdout.log'),child.stdout||'');writeFileSync(join(workspace,'host.stderr.log'),child.stderr||'');
  console.log(JSON.stringify({mode,reportPath,exitCode:child.status,signal:child.signal,error:child.error?.message}));
  if(child.error||child.signal||child.status!==0){console.error('LOOP_FAIL_REASON='+mode+'-incomplete');throw Error('宿主验证未完成，原始报告与输出已保留');}
  const report=json(reportPath);
  assert.equal(report.candidateCodeRoot,code);assert.equal(report.status,'PASS');
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
    assert.equal(report.otherResourcesUnchanged,true);
    assert.equal(report.steps.length,7);assert.equal(report.card?.name,'Loop 空壳卡片');
    assert.equal(report.card?.resourceId,'loop-ecology-shell-probe');assert.equal(report.card?.version,'1.0.0');
    const screenshots=new Set();
    for(const action of ['market-visible','install','disable','enable','uninstall','reinstall','upgrade']) {
      const matching=report.steps.filter(s=>s.action===action);assert.equal(matching.length,1,action);
      const step=matching[0];assert.equal(step.attempted,true,action);assert.equal(step.status,'PASS',action);
      assert.equal(step.foreignResourcesUnchanged,true,action);
      recordEvidence(step.rawEvidencePath);recordEvidence(step.screenshotPath,true);screenshots.add(realpathSync(step.screenshotPath));
      const raw=json(step.rawEvidencePath);assert.equal(raw.action,action);assert.equal(raw.attempted,true);assert.equal(raw.status,'PASS');
      assert.equal(raw.nameVerification?.expected,report.card.name);assert.equal(raw.nameVerification?.correct,true);
      assert.ok(raw.nameVerification?.titles?.includes(report.card.name),'本步真实界面必须显示输入名称');
      assert.equal(raw.state?.marketRegistered,true);
      if(['market-visible','uninstall'].includes(action))assert.equal(raw.state?.installed,false);
      else {assert.equal(raw.state?.installed,true);assert.equal(raw.state?.enabled,action!=='disable');assert.equal(raw.state?.version,action==='upgrade'?'1.0.1':'1.0.0');}
    }
    assert.equal(screenshots.size,7,'七步必须分别留截图，不复用截图路径');
  }
  console.log(JSON.stringify({hostReport:reportPath,reportSha256:createHash('sha256').update(readFileSync(reportPath)).digest('hex'),evidence}));
  console.log('PASS '+mode+'：必需记录齐全；原生操作、截图及保护真实性仍由独立评审判断。');
}
