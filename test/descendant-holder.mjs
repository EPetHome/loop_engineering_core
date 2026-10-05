#!/usr/bin/env node
// 联调/单测辅助：派生一个长时间运行的孙进程（继承 stdout/stderr），自己也不退出。
// 用于验证 childExec 超时后杀整个进程组、有界返回，而不是等后代释放管道。
import { spawn } from "node:child_process";

const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
  stdio: ["ignore", "inherit", "inherit"],
});
grandchild.on("exit", () => process.exit(0));
setTimeout(() => {}, 60000);
