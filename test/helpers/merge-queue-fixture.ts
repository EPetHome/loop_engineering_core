/** 只构造历史 JSON，不调用已删除的旧登记/队列执行器。 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { queueDir, readMergeQueue, type MergeQueue } from "../../merge-queue.ts";
import { recordBatchInfo, type BatchInfo } from "../../events.ts";
import { legacyFixture } from "./pipeline-fixture.ts";
export function fixture() {
  const f = legacyFixture(), dir = f.raw.dir as string, queue = queueDir(f.repo); mkdirSync(dir, { recursive: true }); mkdirSync(queue, { recursive: true });
  const info: BatchInfo = { project: f.repo, batch: { file: f.oldFile, name: f.raw.name, recipe: "develop" }, dir, stages: [{ stage: "甲", cwd: f.repo }] };
  recordBatchInfo(info);
  const state: MergeQueue = { version: 1, repo: f.repo, common: f.git(f.repo, "rev-parse", "--path-format=absolute", "--git-common-dir"), dir: queue, workspace: join(queue, "worktree"), nextOrder: 2, batches: [{ id: "history", name: f.raw.name, file: f.oldFile, dir, project: f.repo, release: "dev", stages: [{ name: "甲", cwd: f.repo, branch: "feat/old", start: "do-not-run" }], steps: [["甲"]] }], entries: [{ id: "entry", batch: "history", name: "旧候选", order: 1, status: "pending", qualification: [], sources: [], attempt: 0, createdAt: "historical", updatedAt: "historical" }] };
  const file = join(queue, "queue.json"), save = () => writeFileSync(file, JSON.stringify(state)); save();
  return { ...f, info, history: state, queueFile: file, saveHistory: save, read: () => readMergeQueue(f.repo)!, bytes: () => readFileSync(file), close: f.cleanup };
}
