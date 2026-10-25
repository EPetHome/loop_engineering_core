#!/bin/sh
# 模板说明：被测系统的启动命令（.autoreview.json 的 acceptance.start）。由程序启动、程序关停，验收方不许自己跑。
# 规则：读 PORT；拒绝线上端口；端口被占就退出；只连测试库、测试 Redis db、测试账号；日志写到 $AUTOREVIEW_RUN_DIR；
#       凭据现取现用（从容器或钥匙串），不写进文件、不打印。
# Promate 实例：dev分支/deploy/acceptance/start.sh（旧流程；端口 38081，库 promate_v2_accept，Redis db 7）
set -eu
PORT=${PORT:-38081}
case "$PORT" in 8080|8081|8082|8083|8084) echo 'Production port forbidden' >&2; exit 1;; esac   # 换成本项目的线上端口
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo "port $PORT in use" >&2; exit 1; fi
RUN_DIR=${AUTOREVIEW_RUN_DIR:-$(mktemp -d)}
export SERVER_PORT="$PORT"
export LOG_FILE="$RUN_DIR/app.log"
# export DB_URL='<测试库连接串>'      # 测试库，不能是线上库
# export REDIS_DATABASE=<测试用 db>
# exec <启动命令>
