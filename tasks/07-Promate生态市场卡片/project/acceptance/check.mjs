// Frozen acceptance: candidate modules run in temporary directories, never the user's profile.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const [mode, codeArg, workspaceArg] = process.argv.slice(2);
assert.ok(['a','b','c','host'].includes(mode));
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
  assert.equal(typeof entry.source,'string');assert.ok(entry.source.startsWith('./'));
  const pluginRoot=resolve(first.marketRoot,entry.source);within(realpathSync(first.marketRoot),realpathSync(pluginRoot));
  const plugin=json(join(pluginRoot,'.codebuddy-plugin/plugin.json'));
  assert.equal(plugin.name,first.pluginName);assert.equal(plugin.version,'1.0.0');
  assert.equal(plugin.description,input.card.description);
  assert.deepEqual(files(pluginRoot).map(p=>relative(pluginRoot,p)),['.codebuddy-plugin/plugin.json']);
  const again=await generateMarket({...input,outputRoot});
  assert.equal(again.pluginName,first.pluginName);assert.equal(again.marketRoot,first.marketRoot);
  const next=await generateMarket({...input,outputRoot,card:{...input.card,name:'改名后的测试卡片',version:'1.0.1'}});
  assert.equal(next.pluginName,first.pluginName);assert.equal(next.marketRoot,first.marketRoot);
  assert.equal(json(join(pluginRoot,'.codebuddy-plugin/plugin.json')).version,'1.0.1');
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

if(mode==='a'||mode==='c')await checkA();
if(mode==='b'||mode==='c')await checkB();
if(mode==='host') {
  const reportPath=join(workspace,'host-result.json');
  const child=spawnSync(process.execPath,[join(feature,'integration/index.mjs'),'--workspace',workspace,'--report',reportPath],
    {cwd:code,encoding:'utf8',timeout:900000,maxBuffer:8*1024*1024});
  writeFileSync(join(workspace,'host.stdout.log'),child.stdout||'');writeFileSync(join(workspace,'host.stderr.log'),child.stderr||'');
  if(child.error||child.signal||child.status!==0){console.error('LOOP_FAIL_REASON=host-run-incomplete');throw Error('宿主流程未完成，详见门禁工作目录的原始输出');}
  const report=json(reportPath);
  assert.equal(report.candidateCodeRoot,code);assert.equal(report.status,'PASS');
  assert.ok(report.hostVersion);assert.ok(report.profile && report.profile.startsWith('/private/tmp/loop-card-'));
  assert.equal(report.otherResourcesUnchanged,true);assert.equal(report.managedProcessesStopped,true);
  const evidence=[];
  for(const action of ['market-visible','install','disable','enable','uninstall','reinstall','upgrade']) {
    const step=report.steps.find(s=>s.action===action);assert.ok(step,action);assert.equal(step.status,'PASS',action);
    assert.ok(step.rawEvidencePath,action);within(workspace,resolve(step.rawEvidencePath));assert.ok(readFileSync(step.rawEvidencePath).length);
    assert.ok(step.screenshotPath,action);within(workspace,resolve(step.screenshotPath));
    assert.equal(readFileSync(step.screenshotPath).subarray(0,8).toString('hex'),'89504e470d0a1a0a');
    for(const path of [step.rawEvidencePath,step.screenshotPath])evidence.push({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')});
  }
  console.log(JSON.stringify({hostReport:reportPath,reportSha256:createHash('sha256').update(readFileSync(reportPath)).digest('hex'),evidence}));
  console.log('PASS C：宿主流程证据齐全；真实性和界面含义仍由独立评审核对。');
}
