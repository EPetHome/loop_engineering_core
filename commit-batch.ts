/** 只读历史结构：query.ts/旧交付总表展示使用。旧批次提交及分支推送执行器已删除。 */
export interface BatchCommit {
  branch: string; cwd: string; base: string; commit: string; tree: string;
  preSquash: string[]; pushed?: string;
  pushResult?: { status: "started" | "succeeded" | "failed"; reason?: string };
}
