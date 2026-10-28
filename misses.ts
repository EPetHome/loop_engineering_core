/** 漏网登记：只读原会话，追加本机总表与回放草稿；不调模型、不重新评审。 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { appendMissRecord, deliveryLedgerPath, projectRootOf } from "./ledger.ts";
import { readRecordedSession } from "./materials.ts";
import { readReviewSnapshot, sha256 } from "./snapshots.ts";

/** 字段与 eval/README.md 对齐；未知值必须显式 null，不自动给草稿分配正式 Lnnn 编号。 */
export interface MissDraft {
  id: string;
  type: "漏网-评审";
  project: string;
  repository: string;
  gitDir: string | null;
  baseline: string | null;
  candidate: string | null;
  reviewInput: string | null;
  inputSha256: string | null;
  defect: string;
  location: null;
  discovery: string;
  evidence: string[];
  replayable: boolean;
  replayReason: string;
  status: "draft";
  session: string;
  round: number;
  loopCommit: string | null;
  snapshot: string | null;
  snapshotSha256: string | null;
  untracked: { path: string; hash: string; mode: string; blobFile: string | null }[] | null;
}

export function registerMiss(options: {
  project: string; session: string; round?: number; defect: string; discovery: string; dryRun?: boolean;
  dataRoot?: string; piSessionsRoot?: string;
}): { draft: MissDraft; draftPath: string; ledger: string } {
  const { session: id, defect, discovery } = options;
  if (!defect.trim() || !discovery.trim()) throw new Error("问题描述和发现方式不能为空");
  const project = projectRootOf(resolve(options.project));
  const { session, state } = readRecordedSession(project, id, options);
  const selected = options.round === undefined ? state.rounds.at(-1) : state.rounds.find((item: any) => item.round === options.round);
  if (!selected || !Number.isInteger(selected.round) || selected.round < 1) throw new Error("会话中不存在指定轮次，或会话尚无评审轮次");
  const snapshotPath: string | null = selected.snapshot ?? state.reviewSnapshots?.findLast((item: any) => item.round === selected.round)?.path ?? null;
  const snapshot = snapshotPath ? readReviewSnapshot(snapshotPath) : undefined;
  if (snapshot && (snapshot.project !== project || snapshot.session !== id || snapshot.round !== selected.round
    || resolve(snapshot.workDir) !== resolve(session.workDir))) throw new Error("快照与项目、会话或轮次不匹配，未登记");
  const legacyInput = join(dirname(session.summary), `review-input-${id}-r${selected.round}.md`);
  const reviewInput = snapshot ? join(dirname(snapshotPath!), snapshot.reviewInput) : existsSync(legacyInput) ? legacyInput : null;
  const missing = snapshot?.files.filter((file) => !file.content).map((file) => file.path) ?? [];
  const draft: MissDraft = {
    id: `L-draft-${randomUUID()}`, type: "漏网-评审", project: basename(project), repository: snapshot?.repository ?? project,
    gitDir: snapshot?.gitDir ?? null, baseline: snapshot?.baseline ?? null, candidate: snapshot?.candidate.ref ?? null,
    reviewInput, inputSha256: snapshot?.inputSha256 ?? (reviewInput ? sha256(readFileSync(reviewInput)) : null),
    defect, location: null, discovery, evidence: [session.summary, ...(snapshotPath ? [snapshotPath] : [])],
    replayable: snapshot?.complete === true,
    replayReason: !snapshot ? "历史轮次没有可复原快照，候选与基线不能确定；需补证据"
      : missing.length ? `快照缺少未跟踪内容：${missing.join("、")}` : "同轮输入与全部代码内容已保存并校验；漏网事实与位置仍待用户或 Codex 核对",
    status: "draft", session: id, round: selected.round, loopCommit: snapshot?.loopCommit ?? null,
    snapshot: snapshotPath, snapshotSha256: snapshotPath ? sha256(readFileSync(snapshotPath)) : null,
    untracked: snapshot ? snapshot.files.filter((file) => file.kind === "untracked").map((file) => ({
      path: file.path, hash: file.hash, mode: file.mode, blobFile: file.content ? join(dirname(snapshotPath!), file.content) : null,
    })) : null,
  };
  const root = options.dataRoot ?? join(homedir(), ".pi-autoreview");
  const draftPath = join(root, "replay-drafts", `${draft.id}.json`);
  const ledger = options.dataRoot ? join(root, "交付记录.md") : deliveryLedgerPath();
  if (!options.dryRun) {
    mkdirSync(dirname(draftPath), { recursive: true, mode: 0o700 });
    writeFileSync(draftPath, `${JSON.stringify(draft, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    try { appendMissRecord({ project, session: id, round: selected.round, defect, discovery, summary: session.summary,
      snapshot: snapshotPath, draft: draftPath }, ledger); }
    catch (error) { throw new Error(`案例草稿已保存：${draftPath}；交付总表追加失败：${String(error)}`); }
  }
  return { draft, draftPath, ledger };
}
