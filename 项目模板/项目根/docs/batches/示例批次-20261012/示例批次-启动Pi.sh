#!/bin/bash
# 模板说明：启动脚本，由用户在终端执行 bash <本文件>（协调方不代为启动，只在聊天里给出这条命令）。
# dev分支 不是 git 仓库，取证靠外部基线，GIT_DIR / GIT_WORK_TREE 在这里设置。
# 恢复同一个会话：在 pi 参数里加 --session <开发会话id>；不要用 pi -c，可能会选到评审会话。
# Promate 实例：coding/docs/P0缺陷修复-20261012/P0缺陷修复-启动Pi.sh（它首次运行时还会顺带建 dev分支2）
set -euo pipefail
W=/path/to/项目根/dev分支                                   # 换成 dev分支 的绝对路径
G=$HOME/.pi-autoreview/git-baselines/dev分支.git
P=/path/to/项目根/docs/prompt/提示词-示例.md                 # 换成提示词的绝对路径
[ -d "$G" ] || { echo "外部基线不存在：$G" >&2; exit 1; }
cd "$W"
export GIT_DIR=$G GIT_WORK_TREE=$W
PATH="/Users/Admin/.hermes/node/bin:$PATH" exec /Users/Admin/.local/bin/pi \
  --offline \
  --model openai-codex/gpt-6.1-sol --thinking max \
  --no-extensions --no-skills --no-prompt-templates --no-themes \
  --tools read,edit,write,bash \
  -e /Users/Admin/.pi/agent/npm/node_modules/@gotgenes/pi-permission-system/src/index.ts \
  -e /Users/Admin/Desktop/loop/autoreview.ts \
  --autoreview-reviewer-model openai-codex/gpt-6-astra --autoreview-reviewer-thinking xhigh \
  --name 示例批次 \
  "@$P"
