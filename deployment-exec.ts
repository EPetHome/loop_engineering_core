/** 新旧部署共用的实际命令/日志/进程/资源边界；不认识队列或节点调度。 */
import { appendFileSync } from "node:fs";
import type { Exec, ExecResult } from "./git.ts";
import { createRunResource, managedShell, releaseRunResource, type RunResource } from "./resources.ts";
export async function executeDeploymentCommand(options: {
  command: string; phase: string; commit: string; cwd: string; timeoutMin: number; procs: string; log: string; label?: string;
  exec: Exec; signal?: AbortSignal; env?: NodeJS.ProcessEnv; live: () => void;
}): Promise<ExecResult & { resource: RunResource }> {
  options.live(); options.signal?.throwIfAborted();
  const resource = createRunResource(options.label ?? `deployment:${options.phase}:${options.commit}`,  undefined, options.procs);
  let result: ExecResult | undefined;
  try {
    appendFileSync(options.log, `\n${new Date().toISOString()} [${options.phase}] $ ${options.command}\ncwd: ${options.cwd}\ncommit: ${options.commit}\n`);
    options.live(); options.signal?.throwIfAborted();
    result = await options.exec("/bin/sh", ["-c", managedShell(`exec 2>&1\n${options.command}`, resource)], {
      cwd: options.cwd, timeout: options.timeoutMin * 60_000, signal: options.signal, role: `部署 ${options.phase}`,
      env: { ...options.env, AUTOREVIEW_DEPLOY_COMMIT: options.commit }, onOutput: (chunk) => appendFileSync(options.log, chunk),
    });
    appendFileSync(options.log, `\nexit=${result.code}; killed=${result.killed}; released=${result.processesReleased}\n${result.stdout}\n${result.stderr}\n`);
  } finally {
    const release = releaseRunResource(resource);
    if (result) result.processesReleased = result.processesReleased === true && release.status === "released";
  }
  return { ...result!, resource };
}
