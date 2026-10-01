#!/usr/bin/env python3
"""把 pi 接成 Loop Engineering 的成员（自定义 command 适配器用）。

为什么不用引擎内置的 pi 接法：内置接法禁止加载扩展，而本机约定每次启动 pi 都要带
权限插件；内置接法也不带 --offline 和思考档位。

本脚本做三件事：
1. 按本机约定拼出 pi 命令，把引擎从标准输入给的提示原样交给 pi；
2. 阻塞等 pi 结束（pi 的非交互模式一结束回合就退出，所以这里不需要、也不允许后台等待）；
3. 从 pi 最后的输出里取出那一个 JSON 对象，只把它打印到标准输出，交给引擎。

只做格式整理（去掉 Markdown 围栏、前后说明文字），不改 JSON 里的任何内容。
取不出合法 JSON 时把 pi 的原始输出照样打印出来，由引擎按「交付格式错误」处理。
pi 的原始输出和本脚本的说明都写到标准错误，留在引擎的 stderr.log 里。

用法（写在任务规则的 agents.<名> 里，output 必须是 "stdout"）：
  "argv": ["{python}", "/绝对路径/pi_member.py",
           "--model", "<服务商/型号>", "--thinking", "<档位>", "--tools", "<工具列表>"]

环境变量（可选，测试用）：
  LOOP_PI_BIN   替换 pi 可执行文件（默认 /Users/Admin/.local/bin/pi）
"""
import argparse
import json
import os
import subprocess
import sys

PI_DEFAULT = "/Users/Admin/.local/bin/pi"
NODE_BIN = "/Users/Admin/.hermes/node/bin"
PERMISSION_EXT = "/Users/Admin/.pi/agent/npm/node_modules/@gotgenes/pi-permission-system/src/index.ts"
TAIL_MESSAGE = "按上面的说明完成任务。最终回复只输出一个 JSON 对象，不加 Markdown 围栏，不加任何前后说明。"


def extract_json(text: str):
    """从整段输出里取出唯一的顶层 JSON 对象；取不出返回 None。"""
    body = text.strip()
    if body.startswith("```"):
        lines = body.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip().startswith("```"):
            lines = lines[:-1]
        body = "\n".join(lines).strip()
    candidates = [body]
    start, end = body.find("{"), body.rfind("}")
    if start != -1 and end > start:
        candidates.append(body[start:end + 1])
    for candidate in candidates:
        try:
            value = json.loads(candidate)
        except ValueError:
            continue
        if isinstance(value, dict):
            return value
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--thinking", required=True)
    ap.add_argument("--tools", required=True)
    args = ap.parse_args()

    prompt = sys.stdin.read()
    if not prompt.strip():
        print("pi_member: 标准输入里没有提示", file=sys.stderr)
        return 2

    env = dict(os.environ)
    env["PATH"] = NODE_BIN + os.pathsep + env.get("PATH", "")
    name = "loop-%s-%s" % (os.environ.get("LOOP_UNIT_ID", "unit"), os.environ.get("LOOP_ATTEMPT_ID", "attempt"))
    argv = [os.environ.get("LOOP_PI_BIN", PI_DEFAULT), "--offline",
            "--model", args.model, "--thinking", args.thinking,
            "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
            "--tools", args.tools, "-e", PERMISSION_EXT, "--name", name, "-p", TAIL_MESSAGE]
    print("pi_member: " + " ".join(argv[:-1]) + " <结尾提示>", file=sys.stderr)
    done = subprocess.run(argv, input=prompt, capture_output=True, text=True, env=env)
    sys.stderr.write(done.stderr)
    sys.stderr.write("\n----- pi 原始输出开始 -----\n" + done.stdout + "\n----- pi 原始输出结束 -----\n")
    if done.returncode != 0:
        print("pi_member: pi 退出码 %d" % done.returncode, file=sys.stderr)
        return done.returncode

    value = extract_json(done.stdout)
    if value is None:
        print("pi_member: 没能从输出里取出 JSON 对象，原样交给引擎判定", file=sys.stderr)
        sys.stdout.write(done.stdout)
    else:
        json.dump(value, sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
