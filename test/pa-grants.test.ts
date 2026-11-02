import "./test-env.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { authorizationStatus, criteriaFromUser, type Criteria } from "../acceptance-core.ts";
import { bindPAGrant, grantsPath, mergePAGrants, paCriteriaHash, readPAGrants, type PAGrant } from "../pa-records.ts";

const SOURCE = "## 验收标准\nA1. 操作：本地一\nA2. 操作：本地二\nA3. [授权] 操作：正式账号只读\n    预期：列出记录\n";
const criteria = (source = SOURCE, version = 1): Criteria => ({ ...criteriaFromUser(source)!, version });
const row = (id: string, text = "同意授权：全部"): PAGrant => ({ id, text, at: new Date().toISOString(), via: "pa" });
const save = (dir: string, rows: PAGrant[]) => writeFileSync(grantsPath(dir), rows.map((item) => JSON.stringify(item)).join("\n") + "\n");
function fixture(t: test.TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "loop-pa-grants-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("返修1：续跑答复在写入时绑定标准，首次使用前新增授权项也不得扩权", (t) => {
  const dir = fixture(t), original = criteria(), reply = bindPAGrant(dir, row("original"), original, SOURCE);
  assert.equal(reply.criteriaHash, paCriteriaHash(original, SOURCE)); assert.ok(reply.criteriaEpoch);
  save(dir, [reply]);
  const source = SOURCE + "A4. [授权] 操作：真实扣费\n    预期：扣费成功\n", current = criteria(source);
  const merged = mergePAGrants(dir, source, current);
  assert.deepEqual(authorizationStatus(current, merged.grants).pending, ["A3", "A4"]); assert.deepEqual(merged.used, []);
  const fresh = bindPAGrant(dir, row("fresh"), current, source); save(dir, [reply, fresh]);
  const answered = mergePAGrants(dir, source, current);
  assert.deepEqual(answered.grants!.approved, ["A3", "A4"]); assert.deepEqual(answered.used, ["fresh"]);
  assert.deepEqual(readPAGrants(dir).map((item) => item.id), ["original", "fresh"], "失效编号仍完整保留供查询对账");
});

test("返修1：新增条目、同编号内容、版本、段归属变化均使历史 PA 授权失效", async (t) => {
  const root = fixture(t);
  const cases = [
    { name: "新增授权条目", source: SOURCE + "A4. [授权] 操作：真实扣费\n", version: 1, pending: ["A3", "A4"] },
    { name: "同编号操作变化", source: SOURCE.replace("正式账号只读", "删除正式账号数据"), version: 1, pending: ["A3"] },
    { name: "同编号预期变化", source: SOURCE.replace("列出记录", "扣款成功"), version: 1, pending: ["A3"] },
    { name: "只有版本变化", source: SOURCE, version: 2, pending: ["A3"] },
    { name: "段归属变化", source: SOURCE.replace("A3. [授权]", "A3. [乙] [授权]"), version: 1, pending: ["A3"] },
  ];
  for (const item of cases) await t.test(item.name, () => {
    const dir = join(root, item.name); mkdirSync(dir);
    const original = criteria(), reply = bindPAGrant(dir, row("all"), original, SOURCE); save(dir, [reply]);
    assert.deepEqual(mergePAGrants(dir, SOURCE, original).used, ["all"]);
    const current = criteria(item.source, item.version), merged = mergePAGrants(dir, item.source, current);
    assert.deepEqual(merged.used, []); assert.deepEqual(authorizationStatus(current, merged.grants).pending, item.pending);
    assert.deepEqual(mergePAGrants(dir, SOURCE, original).used, [], "标准改回原文也不复活已失效的授权代次");
  });
});

test("返修1/A9：直接写入的原文首读冻结；跨进程、标准变化及同编号篡改不重新解释", (t) => {
  const dir = fixture(t), original = criteria(), direct = row("direct-all"); save(dir, [direct]);
  assert.deepEqual(mergePAGrants(dir, SOURCE, original).grants!.approved, ["A3"]);
  const frozen = readFileSync(join(dir, "grants.pa.bindings.json"), "utf8");
  const module = new URL("../pa-records.ts", import.meta.url).href;
  const code = `import {mergePAGrants} from ${JSON.stringify(module)}; console.log(JSON.stringify(mergePAGrants(${JSON.stringify(dir)},${JSON.stringify(SOURCE)},${JSON.stringify(original)})));`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr); assert.deepEqual(JSON.parse(child.stdout).used, ["direct-all"]);
  assert.equal(readFileSync(join(dir, "grants.pa.bindings.json"), "utf8"), frozen);
  const source = SOURCE + "A4. [授权] 操作：真实扣费\n", current = criteria(source);
  const merged = mergePAGrants(dir, source, current);
  assert.deepEqual(merged.used, []); assert.deepEqual(authorizationStatus(current, merged.grants).pending, ["A3", "A4"]);
  const fresh = row("direct-fresh", "不授权：A3\n同意授权：A4"); save(dir, [direct, fresh]);
  const answered = mergePAGrants(dir, source, current);
  assert.deepEqual(answered.used, ["direct-fresh"]); assert.deepEqual(answered.grants, { version: 1, approved: ["A4"], denied: ["A3"] });
  save(dir, [direct, { ...fresh, text: "同意授权：全部" }]);
  assert.deepEqual(mergePAGrants(dir, source, current).used, [], "同一 PA 编号不能改原文后重新绑定");
});

test("返修1：未读取的旧直接授权不能因新答复建立新标准代次而混入授权", (t) => {
  const dir = fixture(t), original = criteria(); mergePAGrants(dir, SOURCE, original);
  const legacy = row("old-direct"); save(dir, [legacy]);
  const source = SOURCE + "A4. [授权] 操作：真实扣费\n", current = criteria(source);
  const fresh = bindPAGrant(dir, row("new-answer", "同意授权：A4"), current, source); save(dir, [legacy, fresh]);
  const merged = mergePAGrants(dir, source, current);
  assert.deepEqual(merged.used, ["new-answer"]); assert.deepEqual(authorizationStatus(current, merged.grants).pending, ["A3"]);
  assert.deepEqual(merged.grants!.approved, ["A4"]);
});
