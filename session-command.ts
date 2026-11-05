/** 恢复会话的稳定组长：shell/宿主可反复 exec，组长保留启动时的归属标记直到命令收尾。 */
import { spawn } from "node:child_process";

const command = process.argv[2];
if (!command) {
  process.stderr.write("缺少原会话恢复命令\n");
  process.exitCode = 1;
} else {
  let cancelled: number | undefined;
  const handlers = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map((signal) => ({ signal, handler: () => {
    // 信号发给本独立组，shell/宿主也已收到；组长只等待收尾，不向共享终端组重发。
    cancelled ??= signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143;
  } }));
  for (const { signal, handler } of handlers) process.on(signal, handler);
  const child = spawn("/bin/sh", ["-c", command], { stdio: "inherit", detached: false });
  child.once("error", (error) => { process.stderr.write(`恢复原会话失败：${String(error)}\n`); });
  child.once("close", (code) => {
    for (const { signal, handler } of handlers) process.off(signal, handler);
    process.exitCode = code || cancelled || (code === 0 ? 0 : 1);
  });
}
