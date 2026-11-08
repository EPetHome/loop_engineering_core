/** 旧入口迁移反例：真实临时 Git/bare origin，比较原文件/索引/ref/资源，无旧执行器替身。 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { kernelFixture } from "./kernel-fixture.ts";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
export function legacyFixture() {
  const f = kernelFixture(["开发评审"]), file = join(f.repo, "旧批次.json"), executed = join(f.root, "should-not-execute");
  const raw: any = { name: "旧批次", branch: "feat/old", dir: join(f.root, "pipeline"), stages: { 甲: { prompt: "prompt.md", start: `touch '${executed}'`, workspace: "old", workflow: "with-acceptance" } }, steps: [["甲"]], acceptance: { start: `touch '${executed}'`, workDir: f.repo, criteria: "prompt.md" } };
  writeFileSync(file, JSON.stringify(raw));
  const tree = (path: string): unknown => !existsSync(path) ? null : readdirSync(path).sort().filter((n) => n !== ".git").map((n): unknown => { const p = join(path, n), s = lstatSync(p); return [n, s.mode, s.isSymbolicLink() ? ["link", readlinkSync(p)] : s.isDirectory() ? tree(p) : readFileSync(p).toString("base64")]; });
  const snapshot = () => ({ head: f.git(f.repo, "rev-parse", "HEAD"), refs: f.git(f.repo, "show-ref"), index: readFileSync(join(f.repo, ".git/index")).toString("base64"), config: readFileSync(join(f.repo, ".git/config")).toString("base64"), worktrees: f.git(f.repo, "worktree", "list", "--porcelain"), files: tree(f.repo), state: ["old-queues", "resources", "kernel", "local-queue", "projects", "pipeline", "should-not-execute"].map((name) => [name, existsSync(join(f.root, name)) ? lstatSync(join(f.root, name)).isDirectory() ? tree(join(f.root, name)) : readFileSync(join(f.root, name)).toString("base64") : null]) });
  const cli = (args: string[], internal = false) => {
    const entry = internal ? ["--input-type=module", "-e", `import { main } from ${JSON.stringify(join(ROOT, "loop.ts"))}; process.exitCode=await main(process.argv.slice(1),{legacyCompatibility:true});`] : [join(ROOT, "loop.ts")];
    return spawnSync(process.execPath, [...entry, ...args, "--json"], { cwd: f.repo, env: { ...process.env, NODE_NO_WARNINGS: "1", AUTOREVIEW_PIPELINE_LAUNCH: "1", AUTOREVIEW_PIPELINE_LAUNCH_TOKEN: "old", AUTOREVIEW_MERGE_QUEUE_LAUNCHER: "background" }, encoding: "utf8", timeout: 15_000 });
  };
  return { ...f, oldFile: file, raw, executed, snapshot, cli, save: () => writeFileSync(file, JSON.stringify(raw)),
    refuse: (command: string, extra: string[] = [], internal = false) => { const before = snapshot(), r = cli([command, file, ...extra], internal); assert.notEqual(r.status, 0, r.stdout + r.stderr); const out = JSON.parse(r.stdout); assert.match(out.error ?? (typeof out.reason === "string" ? out.reason : out.reason?.text) ?? "", /已停用|新卡|开发卡|迁移/); assert.deepEqual(snapshot(), before, "拒绝不能改变用户文件、索引、分支或资源"); assert.equal(existsSync(executed), false); return out; },
    pipeline: (...args: string[]) => { const before = snapshot(), r = spawnSync(process.execPath, [join(ROOT, "pipeline.ts"), file, ...args], { cwd: f.repo, encoding: "utf8", env: process.env }); assert.equal(r.status, 2); assert.match(r.stderr, /stages.*tasks[\s\S]*workflow\/steps.*flow/); assert.deepEqual(snapshot(), before); },
  };
}
