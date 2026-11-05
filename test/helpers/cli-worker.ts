/** 同一夹具内复用CLI进程；每个请求仍走真实main，环境逐次替换，资源不跨夹具共享。 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

export function createCLIWorker(root: string, cwd: string) {
  const dir = join(root, "cli-worker"); mkdirSync(dir, { mode: 0o700 });
  const child = spawn(process.execPath, [fileURLToPath(new URL("./cli-worker.mjs", import.meta.url)), dir], { cwd, env: process.env, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  const request = join(dir, "request.json"), response = join(dir, "response.json"), waiter = new Int32Array(new SharedArrayBuffer(4));
  const call = (args: string[], stop = false) => {
    const id = randomUUID();
    writeFileSync(request + ".tmp", JSON.stringify({ id, args, stop, env: process.env }), { mode: 0o600 });
    renameSync(request + ".tmp", request);
    child.send({ id });
    const deadline = Date.now() + 30_000;
    while (!existsSync(response)) {
      assert.ok(Date.now() < deadline, `CLI请求超时：${args.join(" ")}；私有现场：${dir}`);
      Atomics.wait(waiter, 0, 0, 20);
    }
    const result: { id: string; status: number; stdout: string; stderr: string } = JSON.parse(readFileSync(response, "utf8"));
    rmSync(response); assert.equal(result.id, id, "不得沿用其他请求的输出");
    return result;
  };
  return { call: (args: string[]) => call(args), async close() { call([], true); assert.equal(await exited, 0, "CLI执行进程应已退出后再释放夹具"); } };
}
