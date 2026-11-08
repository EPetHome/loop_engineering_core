/** 提交节点：按仓库/目标互斥，只核对账本并发布；不评审、不测试、不验收。 */
import { closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative } from "node:path";
import { eventLock } from "./events.ts";
import { contributionProblems, currentCandidate, kernelCommand, qualification, type NodeInput, type NodeOutput } from "./kernel.ts";
import { atomicRun, findUserDecision, readRun, updateRun, validResult, taskIds, taskView, type UserDecision } from "./node-ledger.ts";
import { checkInputs, fileDigest, frozenCardProblem, gitRaw } from "./kernel-workspace.ts";
import { digest, inside, type NodeName } from "./development-card.ts";
import { acquireProjectExecution } from "./project-execution.ts";
import { gitResult, gitText, worktreeForBranch } from "./workspace.ts";

const intersects = (a: string, b: string): boolean => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
/** 目标上不属于本次发布的索引及原始文件必须逐字保持；不通过 stash/reset 暂存用户成果。 */
function protectedTarget(cwd: string, touched: string[]): string {
  const keep = (p: string): boolean => !touched.some((t) => intersects(p, t));
  const paths = [...new Set(gitRaw(cwd, ["ls-files", "--cached", "--others", "-z"]).split("\0").filter(Boolean))].filter(keep).sort();
  const entries = gitRaw(cwd, ["ls-files", "--stage", "-z"]).split("\0").filter(Boolean).filter((line) => keep(line.slice(line.indexOf("\t") + 1)));
  return digest(JSON.stringify([entries, paths.map((p) => [p, existsSync(join(cwd, p)) ? fileDigest(join(cwd, p)) : "缺失"])]));
}

export async function submitCandidate(input: NodeInput, decision?: UserDecision, localOnly = false): Promise<NodeOutput> {
  if (input.run.card.nature === "评审") throw new Error("只评审卡不允许提交或合入");
  const projectRelease = await acquireProjectExecution(input.run.repo, "deploy", input.procsFile!, input.signal, () => input.signal?.throwIfAborted(), () => updateRun(input.ledger, (r) => {
    if (r.activity?.id === input.attempt) r.activity.kind = "waiting";
  }));
  let release: (() => void) | undefined;
  const evidence = join(input.run.dir, `submission-${input.attempt}.log`), operations: string[] = [];
  let targetIndex: { fd: number; file: string; lock: string; scratch: string; installed: boolean } | undefined;
  const log = (s: string): void => { operations.push(s); writeFileSync(evidence, `${operations.join("\n")}\n`); };
  try {
    release = eventLock(join(input.run.common, "loop-kernel-dev.lock"));
    updateRun(input.ledger, (r) => { input.signal?.throwIfAborted(); if (r.activity?.id !== input.attempt || r.stopped || r.pendingCard) throw new Error("提交等待期间停止/改卡或执行身份变化"); r.activity.kind = "submitting"; });
    const run = readRun(input.ledger);
    if (run.card.target !== "dev" || frozenCardProblem(run) || run.stopped || run.abandoned) throw new Error("目标或卡/停止身份变化，未合入");
    if (run.publication) throw new Error("已有发布意图/结果；禁止重复合入或自动重试推送，请查询记录");
    const q = qualification(run), candidate = currentCandidate(run);
    const sources = contributionProblems(run, false); if (sources.length) throw new Error(`批次来源核对失败（例外不能豁免）：${sources.join("；")}`);
    if (candidate.tree !== input.candidate.tree || checkInputs(run).hash !== input.inputs || run.activity?.id !== input.attempt) throw new Error("提交排队期间候选、输入或执行代次变化");
    if (decision && !findUserDecision(run, candidate, input.inputs, q.missing, decision.id)) throw new Error("真实用户决定已过期，须按当前候选和完整检查输入重新确认");
    if (q.missing.length && !decision) throw new Error(`合入资格不足：\n${q.missing.join("\n")}`);
    const target = gitText(run.repo, ["rev-parse", "refs/heads/dev"]);
    const merged = gitResult(run.repo, ["merge-tree", "--write-tree", target, candidate.commit]);
    if (merged.status !== 0 || merged.stdout.split("\n")[0].trim() !== candidate.tree) throw new Error(`目标 dev 已前进或存在冲突；实际合并不是已检查树 ${candidate.tree}，未发布。补救：${kernelCommand("整合", run.file)}，然后 ${kernelCommand("续跑", run.file)} 在原会话重新交付；不能以无冲突代替检查。${merged.stderr}`);
    const holder = worktreeForBranch(run.repo, "dev");
    const touched = gitRaw(run.repo, ["diff", "--name-only", "--no-renames", "-z", target, candidate.commit, "--"]).split("\0").filter(Boolean);
    const cardPath = relative(run.repo, run.file).replace(/\\/g, "/");
    if (inside(run.repo, run.file) && touched.includes(cardPath)
      && digest(gitRaw(run.repo, ["show", `${candidate.commit}:${cardPath}`])) !== run.cardHash) throw new Error("本任务不能通过发布修改冻结开发卡；恢复原卡后重新交付");
    let protectedBefore = "", statusBefore = "", frozenMetadata = false, metadataDigest = "";
    const status = (): string => {
      const raw = gitRaw(holder!.path, ["status", "--porcelain", "-z", "--untracked-files=all"]);
      // 仅冻结卡的已确认工作副本由本次元数据同步变 clean；其他用户状态逐字保留。
      if (frozenMetadata && fileDigest(join(holder!.path, cardPath)) !== metadataDigest) throw new Error("目标冻结卡发生未知内容/模式变化，未覆盖或推送");
      return frozenMetadata ? raw.split("\0").filter((line) => line !== ` M ${cardPath}`).join("\0") : raw;
    };
    if (holder) {
      const file = gitText(holder.path, ["rev-parse", "--path-format=absolute", "--git-path", "index"]), lock = `${file}.lock`;
      const fd = openSync(lock, "wx", 0o600), scratch = join(run.dir, `target-index-${input.attempt}`);
      targetIndex = { fd, file, lock, scratch, installed: false }; copyFileSync(file, scratch);
      const flags = gitRaw(holder.path, ["ls-files", "-v", "-z"]).split("\0").filter(Boolean);
      if (flags.some((line) => !line.startsWith("H "))) throw new Error("目标索引含隐藏或未解决状态，未覆盖");
      const changed = [...gitRaw(holder.path, ["diff", "--name-only", "--no-renames", "-z", "HEAD", "--"]).split("\0"),
        ...gitRaw(holder.path, ["diff", "--cached", "--name-only", "--no-renames", "-z", "HEAD", "--"]).split("\0"),
        ...gitRaw(holder.path, ["ls-files", "--others", "-z"]).split("\0")].filter(Boolean);
      const cardFile = join(holder.path, cardPath);
      if (inside(run.repo, run.file) && touched.includes(cardPath) && existsSync(cardFile)) {
        const info = lstatSync(cardFile), entry = gitRaw(run.repo, ["ls-tree", "-z", candidate.commit, "--", cardPath]);
        const staged = gitRaw(holder.path, ["diff", "--cached", "--name-only", "--no-renames", "-z", "HEAD", "--"]).split("\0").filter(Boolean);
        frozenMetadata = info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && digest(readFileSync(cardFile)) === run.cardHash
          && Boolean(info.mode & 0o111) === entry.startsWith("100755 ") && !staged.some((p) => intersects(p, cardPath));
        if (frozenMetadata) metadataDigest = fileDigest(cardFile);
      }
      const overlap = changed.filter((p) => !(frozenMetadata && p === cardPath) && touched.some((t) => intersects(p, t)));
      if (overlap.length) throw new Error(`目标工作区有重叠未提交或未跟踪改动，未覆盖：${overlap.join("、")}`);
      statusBefore = status();
      protectedBefore = protectedTarget(holder.path, touched);
    }
    const checkout = (args: string[]): void => {
      if (!holder || !targetIndex) return;
      const r = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: holder.path,
        env: { ...process.env, GIT_INDEX_FILE: targetIndex.scratch }, encoding: "utf8", timeout: 120_000 });
      // --refresh 只刷新私有索引 stat，不暂存内容；无交集的未暂存文件可报告 needs update。
      if (r.status !== 0 && !(args[0] === "update-index" && r.status === 1 && !r.stderr.trim())) throw new Error(`目标工作区更新失败：${r.stderr || r.stdout || r.error}`);
    };
    if (holder && existsSync(gitText(holder.path, ["rev-parse", "--path-format=absolute", "--git-path", "MERGE_HEAD"]))) throw new Error("目标有未完成合并，未触碰");
    const origin = localOnly ? "" : gitText(run.repo, ["remote", "get-url", "--push", "origin"]);
    const prefix = `refs/loop/kernel/${run.id}/pre-squash/`;
    const refs = gitText(run.repo, ["for-each-ref", "--format=%(refname)", prefix]).split("\n").filter(Boolean);
    const sequence = Math.max(0, ...refs.map((r) => Number(r.slice(prefix.length)) || 0)) + 1;
    const history = `${prefix}${sequence}`;
    gitText(run.repo, ["update-ref", history, candidate.commit, "0".repeat(40)]);
    const commit = gitText(run.repo, ["-c", "core.hooksPath=/dev/null", "commit-tree", candidate.tree, "-p", target, "-m",
      `chore: ${run.card.name}\n\n任务：${run.card.tasks.map((t) => t.name).join("、")}\n${decision ? "用户接受未验证（不改写检查结论）" : "按开发卡前置结论合入"}\n历史：${history}`]);
    log(`候选 ${candidate.commit} / ${candidate.tree}；目标 dev ${target}；压缩历史 ${history}；发布提交 ${commit}`);
    if (frozenMetadata) {
      const [mode, , blob] = gitText(run.repo, ["ls-tree", candidate.commit, "--", cardPath]).split(/[ \t]/);
      checkout(["update-index", "--cacheinfo", mode, blob, cardPath]); // 只在私有索引采用与已确认工作副本完全一致的卡；不暂存其他用户文件。
    }
    checkout(["update-index", "-q", "--refresh"]);
    checkout(["read-tree", "-n", "-m", "-u", target, commit]);
    // 发布意图和 CAS 共用账本短锁：停止/用户输入更新与发布有明确先后，不存在放锁后盲发。
    updateRun(input.ledger, (r) => {
      const checked = checkInputs(r);
      if (r.stopped || r.activity?.id !== input.attempt || r.userVersion !== input.run.userVersion || currentCandidate(r).tree !== candidate.tree || checked.hash !== input.inputs) throw new Error("发布前输入/停止状态变化");
      if (decision && !findUserDecision(r, candidate, checked.hash, qualification(r).missing, decision.id)) throw new Error("发布边界用户决定已失效");
      const sourceProblems = contributionProblems(r, false); if (sourceProblems.length) throw new Error(`发布边界来源已变化（例外不能豁免）：${sourceProblems.join("；")}`);
      const nodeChecks: Partial<Record<NodeName, { inputs: string; result?: string }>> = {};
      const taskChecks: NonNullable<typeof r.publication>["taskChecks"] = [];
      const beforeSubmit = r.card.flow.includes("提交") ? r.card.flow.slice(0, r.card.flow.indexOf("提交")) : r.card.flow;
      for (const node of beforeSubmit) {
        if (r.taskRecords && ["开发评审", "测试"].includes(node)) {
          for (const id of taskIds(r)) {
            const view = taskView(r, id), c = currentCandidate(view), inputs = checkInputs(view, node).hash;
            const source = r.batch!.contributions.find((c) => c.task === id)!, result = validResult(view, node, c, inputs);
            const passed = result && source.checks.includes(result.id) ? result : undefined;
            let bound = taskChecks.find((t) => t.task === id);
            if (!bound) taskChecks.push(bound = { task: id, candidate: c, checks: [] });
            bound.checks.push({ node, inputs, result: passed?.id });
            if (!passed && !decision) throw new Error(`发布边界任务 ${id}/${node} 结论变化，未合入`);
          }
        } else {
          const inputs = checkInputs(r, node).hash, passed = validResult(r, node, candidate, inputs);
          nodeChecks[node] = { inputs, result: passed?.id };
          if (!passed && !decision) throw new Error(`发布边界 ${node} 通过结论已变化，未合入`);
        }
      }
      if (!decision && qualification(r).missing.length) throw new Error("发布边界任务来源映射已变化，未合入");
      if (checkInputs(r).hash !== checked.hash) throw new Error("发布节点输入绑定期间检查输入变化，未合入");
      r.publication = { candidate, inputs: input.inputs, targetBefore: target, commit, tree: candidate.tree, history, origin, nodeChecks, taskChecks, mapping: r.batch ? structuredClone(r.batch.contributions) : undefined,
        inputSnapshot: { files: checked.files, paths: checked.paths, requirement: checked.requirement }, inputRoot: holder?.path,
        at: new Date().toISOString(), local: "intent", push: "未开始", ...(decision ? { decision: decision.id } : {}) };
      if (holder && (protectedTarget(holder.path, touched) !== protectedBefore || status() !== statusBefore)) throw new Error("发布前目标用户文件/索引发生并发变化，未覆盖");
      atomicRun(input.ledger, r); // SIGKILL 后仍有精确的恢复意图。
      gitText(run.repo, ["-c", "core.hooksPath=/dev/null", "update-ref", "refs/heads/dev", commit, target]);
      r.publication.local = "merged";
    });
    log(`本地 CAS 合入 dev：${commit}`);
    if (holder) {
      if (gitText(holder.path, ["rev-parse", "HEAD"]) !== commit) throw new Error("本地已合入后目标又变化；工作区更新与推送均未继续，需核实");
      checkout(["read-tree", "-m", "-u", target, commit]);
      writeFileSync(targetIndex!.fd, readFileSync(targetIndex!.scratch)); fsyncSync(targetIndex!.fd);
      renameSync(targetIndex!.lock, targetIndex!.file); targetIndex!.installed = true;
      if (gitText(holder.path, ["rev-parse", "HEAD^{tree}"]) !== candidate.tree
        || status() !== statusBefore
        || protectedTarget(holder.path, touched) !== protectedBefore) throw new Error("本地已合入，目标工作区/用户索引保护收尾未确认；未推送");
    }
    const pushing = readRun(input.ledger), pushInputs = checkInputs(pushing);
    const transition = join(input.evidenceDir, "publication-inputs.json");
    writeFileSync(transition, JSON.stringify({ before: pushing.publication!.inputSnapshot, observedAfter: pushInputs.observedFiles,
      normalizedPublicationPaths: pushInputs.publicationChanges, checkedIdentity: pushInputs.hash, publication: commit }, null, 2), { mode: 0o600 });
    log(`发布输入核对：${transition}；仅归一化已发布候选造成的更新：${pushInputs.publicationChanges.join("、") || "无"}`);
    if (pushing.stopped || pushing.userVersion !== input.run.userVersion || pushInputs.hash !== input.inputs
      || currentCandidate(pushing).tree !== candidate.tree) throw new Error("本地已合入，但推送前停止/候选/检查输入变化，未推送");
    if (gitText(run.repo, ["rev-parse", "refs/heads/dev"]) !== commit) throw new Error("发布收尾前目标 dev 身份变化，未推送");
    if (localOnly) {
      updateRun(input.ledger, (r) => { r.publication!.push = "未请求"; r.publication!.reason = "按本人要求仅本地合入 dev，未请求远端推送"; });
      log("仅本地合入完成；未请求或执行 git push");
      return { status: "通过", reason: "已本地合入 dev，未推送", evidence: [evidence], operations, released: true };
    }
    if (gitText(run.repo, ["remote", "get-url", "--push", "origin"]) !== origin) throw new Error("推送前 origin 身份变化，未推送");
    updateRun(input.ledger, (r) => { r.publication!.push = "进行中"; });
    const args = ["-c", "core.hooksPath=/dev/null", "push", "--no-follow-tags", "--recurse-submodules=no", "--", "origin", `${commit}:refs/heads/dev`];
    log(`$ git ${args.join(" ")}`);
    const pushed = gitResult(run.repo, args);
    log(`${pushed.stdout}\n${pushed.stderr}`);
    updateRun(input.ledger, (r) => { r.publication!.push = pushed.status === 0 ? "成功" : "失败"; if (pushed.status === 0) r.publication!.remoteCommit = commit; r.publication!.reason = pushed.status === 0 ? undefined : (pushed.stderr || pushed.stdout).trim(); });
    return { status: pushed.status === 0 ? "通过" : "不通过", failure: pushed.status === 0 ? undefined : "environment",
      reason: pushed.status === 0 ? "已本地合入并推送 origin/dev" : `本地已合入，推送失败；保留提交，不自动重试：${pushed.stderr || pushed.stdout}`, evidence: [evidence], operations, released: true };
  } catch (error) {
    log(String(error));
    updateRun(input.ledger, (r) => { if (r.publication) { r.publication.reason = String(error); if (r.publication.push === "进行中") r.publication.push = "失败"; } });
    return { status: "没验证", reason: String(error), failure: "environment", evidence: [evidence], operations, released: true };
  } finally {
    if (targetIndex) { closeSync(targetIndex.fd); if (!targetIndex.installed) rmSync(targetIndex.lock); rmSync(targetIndex.scratch, { force: true }); rmSync(`${targetIndex.scratch}.lock`, { force: true }); }
    release?.(); projectRelease(true);
  }
}
