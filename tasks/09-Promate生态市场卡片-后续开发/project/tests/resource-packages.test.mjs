import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { skillText, zipFixture } from './helpers.mjs';
import { unpackSkill } from '../marketplace/plugins/promate/mcp/packages.mjs';
function stage(fn){const dir=mkdtempSync(join(tmpdir(),'promate-package-'));try{return fn(dir);}finally{rmSync(dir,{recursive:true,force:true});}}

test('K2 .md 和单技能 zip 保留 SKILL name，支持附件与顶层目录',()=>{
  stage(dir=>{assert.equal(unpackSkill(Buffer.from(skillText('fixture-name')),'.md',dir),'fixture-name');assert.equal(readFileSync(join(dir,'SKILL.md'),'utf8'),skillText('fixture-name'));});
  stage(dir=>{assert.equal(unpackSkill(zipFixture([{path:'outer/SKILL.md',text:skillText('real-name')},{path:'outer/assets/data.txt',text:'fixture'}]),'.zip',dir),'real-name');assert.equal(readFileSync(join(dir,'assets/data.txt'),'utf8'),'fixture');});
});
test('K4 拒绝穿越、绝对路径、Windows 路径、符号链接、重复路径和多技能',()=>{
  for(const extra of [{path:'../escape',text:'x'},{path:'/escape',text:'x'},{path:'C:/escape',text:'x'},{path:'a\\b',text:'x'},{path:'link',text:'target',mode:0xa000},{path:'skill.md',text:'x'},{path:'second/SKILL.md',text:skillText('two')}]){
    stage(dir=>assert.throws(()=>unpackSkill(zipFixture([{path:'SKILL.md',text:skillText('one')},extra]),'.zip',dir)));
  }
});
test('K4 拒绝缺少／非法 name、坏CRC、解压大小膨胀及保留归属文件',()=>{
  for(const text of ['# no metadata',skillText('../bad'),skillText('con')])stage(dir=>assert.throws(()=>unpackSkill(Buffer.from(text),'.md',dir)));
  stage(dir=>assert.throws(()=>unpackSkill(zipFixture([{path:'SKILL.md',text:skillText('one'),declaredSize:51*1024*1024}]),'.zip',dir),/50MB/));
  stage(dir=>{const zip=zipFixture([{path:'SKILL.md',text:skillText('one')}]);zip[14]^=1; // local CRC cannot silently diverge from central CRC
    // Also corrupt the central CRC; the decompressed bytes must be checked.
    const central=zip.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));zip[central+16]^=1;
    assert.throws(()=>unpackSkill(zip,'.zip',dir),/CRC/);});
  stage(dir=>assert.throws(()=>unpackSkill(zipFixture([{path:'SKILL.md',text:skillText('one')},{path:'.promate-owner.json',text:'{}'}]),'.zip',dir),/保留/));
});
