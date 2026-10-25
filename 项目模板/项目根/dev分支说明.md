> 模板说明：开发空间不再是一个手工同步的目录，而是 git worktree。运行版是仓库主检出，停在发布分支；每批在 worktree 里从发布分支拉批次分支。此页解释命名和边界，不写进度或会话号。
> Promate 仍是旧的非 git `dev分支/` 结构，按用户决定不迁移；本模板展示新项目的做法。

# dev分支（worktree 开发空间）

## 结构

- 运行版：仓库主检出，停在 `.autoreview.json` 的 `release`（默认 `main`）。只接收合入，不在里面开发。
- 开发空间：`git worktree`，默认 `../<仓库目录名>-dev分支`，可用 `.autoreview.json` 的 `workspaces` 改路径。worktree 和运行版共享 git 历史，但各自检出一个分支。
- 每批在开发空间里从发布分支拉 `<类型>/<描述>` 分支，例如 `feat/示例批次`、`fix/登录超时`。并行时再开 `dev分支2`，每段用不同的 worktree 和分支。
- 开发方（Pi）只改 worktree；不提交。段完成时由程序按 `<类型>: <描述>` 提交，正文写批次名和段名。
- 合入在运行版执行 `bin/loop 合入 <批次.json>`：本地 `merge --no-ff` 批次分支，不推送；冲突时中止并恢复。推送仍由用户授权。
- 分支专属、只在本机存在的文件（例如 `deploy/acceptance/` 验收环境里的具体文件）写进 `.autoreview.json` 的 `localFiles`。接入项目时把模板 `.gitignore.示例` 的内容复制到 `.git/info/exclude`（或项目自己的 `.gitignore`），不要把这些本机文件提交进仓库；模板骨架本身仍随仓库交付。`loop 开工` 检查忽略规则；worktree 缺少时从运行版复制，已有的不覆盖。

## 兼容：非 git 项目与外部基线

外部基线（`GIT_DIR` / `GIT_WORK_TREE`）和 rsync 同步只保留给不是 git 仓库的历史项目，不再是默认流程。新项目用 git worktree 后不需要每批同步、不需要把开工点记到 `~/.pi-autoreview/git-baselines/`；外部基线也不参与 `loop 开工`、`loop 合入` 的默认路径。旧项目要不要迁移，由用户单独授权。

## 已知问题

- `loop 开工` 会拒绝运行版或开发空间的未提交改动，不 stash、不 reset。
- 同一个分支不能同时在两个 worktree 检出；并行时给每段写自己的 `branch` 和 `workspace`。
- 验收环境的端口、测试库和账号必须在并行项目之间隔离；模板只给单套示例。
