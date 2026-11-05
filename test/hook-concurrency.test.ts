/** hook／concurrency：按功能独立运行，夹具与状态不跨测试进程共享。 */
import "./test-env.ts";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { projectDataDir } from "../project-context.ts";
import { HOOK, FAKE, ACC_ENV, fixture } from "./helpers/hook-fixture.ts";

test("评审等待时的新授权或标准跨 Hook 进程生效，旧进程不得启动旧验收或覆盖新输入", async (t) => {
  for (const change of ["revoke", "criteria"]) await t.test(change, async () => {
    const h = fixture({ marker: JSON.stringify({ acceptance: {} }) });
    let child: ReturnType<typeof spawn> | undefined;
    try {
      h.run(h.event("SessionStart"));
      h.run(h.event("UserPromptSubmit", { prompt: "requirement\n## 验收标准\n1. 操作：本地检查\n预期：ok\n2. [授权] 操作：外部同步\n预期：成功\n同意授权：A2" }));
      writeFileSync(h.statePath(), JSON.stringify({ ...h.readState(), repairs: 2 }));
      h.write("file.txt", "base\nchange\n");
      const ready = join(h.root, "review-ready"), release = join(h.root, "review-release"), reviewer = join(h.root, "hold-reviewer.mjs");
      const pass = "## 结论：通过\n## 必修\n无\n## 小问题\n无\n## 需求疑问\n无\n## 上轮必修复查\n无\n";
      writeFileSync(reviewer, `#!${process.execPath}\nimport {writeFileSync,existsSync} from 'node:fs';writeFileSync(${JSON.stringify(ready)},'ready');const t=setInterval(()=>{if(existsSync(${JSON.stringify(release)})){clearInterval(t);process.stdout.write(${JSON.stringify(pass)});}},20);\n`); chmodSync(reviewer, 0o755);
      child = spawn(process.execPath, [HOOK], { cwd: h.repo, stdio: ["pipe", "pipe", "pipe"], env: {
        ...process.env, HOME: h.home, AUTOREVIEW_HOST: "claude", PATH: `${join(h.root, "bin")}:${process.env.PATH}`,
        AUTOREVIEW_DEV_ROOT: h.repo,
        AUTOREVIEW_REVIEWER_CMD: reviewer, AUTOREVIEW_ACCEPTANCE_CMD: ACC_ENV.AUTOREVIEW_ACCEPTANCE_CMD, FAKE_STATE_DIR: join(h.root, "fake"),
      } });
      let stderr = ""; child.stderr!.on("data", (chunk) => { stderr += chunk; });
      const exited = new Promise<number | null>((resolve) => child!.on("exit", resolve));
      child.stdin!.end(JSON.stringify(h.delivered()));
      for (let i = 0; i < 200 && !existsSync(ready) && child.exitCode === null; i++) await new Promise((r) => setTimeout(r, 25));
      assert.ok(existsSync(ready), stderr);
      const oldVersion = h.readState().userInputVersion;
      const prompt = change === "revoke" ? "不授权：A2" : "## 验收标准\n1. 操作：新标准检查\n预期：新的结果";
      const submitted = h.run(h.event("UserPromptSubmit", { prompt })); assert.equal(submitted.code, 0, submitted.stderr);
      assert.notEqual(h.readState().userInputVersion, oldVersion);
      writeFileSync(release, "continue");
      assert.equal(await exited, 0, stderr);
      const state = h.readState();
      assert.equal(state.phase, "paused"); assert.match(state.pauseReason, /用户输入在检查期间更新/);
      assert.equal(state.repairs, 2); assert.equal(state.resumeAfterInputChange, true);
      assert.ok(!existsSync(join(h.root, "fake", "acc-calls.log")), "旧授权下的验收一次也不能启动");
      if (change === "revoke") assert.deepEqual(state.grants, { version: 1, approved: [], denied: ["A2"] });
      else { assert.equal(state.criteria.version, 2); assert.match(state.criteria.items[0].text, /新标准检查/); assert.equal(state.grants, undefined); }
      assert.equal(h.run(h.delivered(), { env: ACC_ENV }).code, 0);
      assert.equal(h.readState().phase, "done"); assert.equal(h.readState().repairs, 2, "新输入的下一次交付可接续，不补发业务次数");
    } finally { if (child?.exitCode === null) child.kill("SIGKILL"); h.close(); }
  });
});

test("来源、配置、Git 或经验登记故障也不能吞掉正在验收时的撤权", async (t) => {
  for (const failure of ['source', 'config', 'removed', 'git', 'experience-read', 'experience-lock']) await t.test(failure, async () => {
    const marker = { acceptance: { cleanup: `node -e 'require("fs").writeFileSync(process.env.AUTOREVIEW_RUN_DIR+"/released","yes")'` }, context: { sources: ['need.md'] } };
    const h = fixture({ marker: JSON.stringify(marker), files: { 'need.md': 'source' } });
    let child: ReturnType<typeof spawn> | undefined;
    try {
      h.run(h.event('SessionStart'));
      h.run(h.event('UserPromptSubmit', { prompt: '需求\n## 验收标准\n1. [授权] 操作：真实检查\n预期：ok\n同意授权：A1' }));
      writeFileSync(h.statePath(), JSON.stringify({ ...h.readState(), repairs: 2 })); h.write('file.txt', 'base\nchange\n');
      const ready = join(h.root, 'tester-ready'), tester = join(h.root, 'hold-tester.mjs');
      writeFileSync(tester, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>{},30000);\n`); chmodSync(tester, 0o755);
      child = spawn(process.execPath, [HOOK], { cwd: h.repo, stdio: ['pipe','pipe','pipe'], env: {
        ...process.env, HOME: h.home, AUTOREVIEW_HOST: 'claude', PATH: `${join(h.root,'bin')}:${process.env.PATH}`,
        AUTOREVIEW_DEV_ROOT: h.repo,
        AUTOREVIEW_REVIEWER_CMD: FAKE, FAKE_MODE: 'pass', FAKE_STATE_DIR: join(h.root,'fake'), AUTOREVIEW_ACCEPTANCE_CMD: tester,
      } });
      let stderr = ''; child.stderr!.on('data', b => { stderr += b; });
      const exited = new Promise<number | null>(resolve => child!.once('exit', resolve)); child.stdin!.end(JSON.stringify(h.delivered()));
      for (let i=0;i<200&&!existsSync(ready)&&child.exitCode===null;i++) await new Promise(r=>setTimeout(r,25));
      assert.ok(existsSync(ready), stderr);
      if (failure === 'source') rmSync(join(h.repo,'need.md'));
      if (failure === 'config') h.write('.autoreview.json','invalid json');
      if (failure === 'removed') rmSync(join(h.repo,'.autoreview.json'));
      const experienceDir = projectDataDir(h.repo, { AUTOREVIEW_PROJECTS_ROOT: join(h.home, '.pi-autoreview', 'projects') });
      const sessions = join(experienceDir, 'experience-sessions.json'), experienceLock = join(experienceDir, 'experience.json.lock');
      const oldVersion = h.readState().userInputVersion;
      if (failure === 'experience-read') writeFileSync(sessions, '{broken registry');
      if (failure === 'experience-lock') {
        mkdirSync(experienceLock); writeFileSync(join(experienceLock, 'owner.json'), JSON.stringify({ pid: process.pid, token: 'fixture-owned-lock' }));
      }
      const reply = h.run(h.event('UserPromptSubmit',{prompt:'不授权：A1'}), failure === 'git' ? {env:{FAKE_GIT_FAIL:'rev-parse'}} : {});
      assert.equal(reply.code,0,reply.stderr);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const code = await Promise.race([exited, new Promise<string>(r => { timer=setTimeout(()=>r('timeout'),5000); })]); if(timer)clearTimeout(timer);
      assert.equal(code,0,stderr);
      const state=h.readState(); assert.deepEqual(state.grants,{version:1,approved:[],denied:['A1']}); assert.equal(state.repairs,2); assert.equal(state.phase,'paused');
      assert.notEqual(state.userInputVersion, oldVersion, '经验故障也必须推进撤权版本，旧 Stop 不能按旧授权完成');
      assert.equal(readFileSync(join(h.home,'.pi-autoreview','repo','acceptance','claude-s1','r1','released'),'utf8'),'yes');
      if (failure.startsWith('experience-')) {
        const approve = () => spawnSync(process.execPath, [fileURLToPath(new URL('../loop.ts', import.meta.url)), '经验', '批准', h.repo, 'C01', '--json'], {
          cwd: h.root, env: { ...process.env, HOME: h.home }, encoding: 'utf8',
        });
        assert.equal(approve().status, 1, '经验登记无法确认时禁止写入');
        if (failure === 'experience-lock') rmSync(experienceLock, { recursive: true });
        writeFileSync(sessions, '{}'); // 模拟聚合登记未成功，不能把空表当成没有活动会话。
        const blocked = approve(); assert.equal(blocked.status, 1); assert.match(JSON.parse(blocked.stdout).error, /进行中的开发会话/);
        assert.equal(existsSync(join(h.repo, '.autoreview', '经验.md')), false);
      }
    } finally {
      if(child?.exitCode===null){child.kill('SIGKILL');const {reapProcs}=await import('../procs.ts');reapProcs(h.statePath().replace(/\.state\.json$/,'.procs.json'),{ownerPid:child.pid});}
      h.close();
    }
  });
});
