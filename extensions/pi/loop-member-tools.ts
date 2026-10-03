/** Loop 0.4.0. Explicitly loaded by the adapter; no nested model calls. */
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { resolve, relative, isAbsolute, dirname } from "node:path";
import { createConnection } from "node:net";

export default function(pi: ExtensionAPI) {
  const contextFile = process.env.LOOP_CONTEXT;
  if (!contextFile) throw new Error("Loop member requires authoritative context");
  const c = JSON.parse(readFileSync(contextFile, "utf8"));
  const socket = process.env.LOOP_MEMBER_SOCKET;
  const token = process.env.LOOP_MEMBER_TOKEN;
  if (!socket || !token || !c.managed_tools) throw new Error("Loop member service unavailable");
  let building = false;
  const readonly = c.role !== "developer" || c.protocol_repair_only;
  function match(p: string, paths: string[]): boolean {
    return paths.some(x => x.endsWith("/") ? (p === x.slice(0, -1) || p.startsWith(x)) : p === x);
  }
  function rpc(method: string, extra: Record<string, unknown> = {}, signal?: AbortSignal): Promise<any> {
    return new Promise((ok, fail) => {
      const client = createConnection(socket!);
      client.setEncoding("utf8");
      let text = "";
      let done = false;
      const finish = (error?: Error, value?: any) => {
        if (done) return; done = true;
        signal?.removeEventListener("abort", abort);
        client.destroy(); error ? fail(error) : ok(value);
      };
      const abort = () => finish(new Error("Tool cancelled; server observes run deadline/cancel"));
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener("abort", abort, { once: true });
      client.setTimeout((Number(c.unit.stage_timeout_seconds) + 15) * 1000);
      client.on("timeout", () => finish(new Error("Loop service timeout")));
      client.on("error", e => finish(e));
      client.on("connect", () => client.write(JSON.stringify({token, method, ...extra}) + "\n"));
      client.on("data", chunk => {
        text += chunk.toString("utf8");
        if (Buffer.byteLength(text) > 262144) { finish(new Error("Oversized tool response")); return; }
        if (text.includes("\n")) {
          try { const r = JSON.parse(text.split("\n")[0]); r.ok ? finish(undefined, r.result) : finish(new Error(r.error)); }
          catch (e) { finish(e as Error); }
        }
      });
      client.on("end", () => { if (!done) finish(new Error("Incomplete tool response")); });
    });
  }
  pi.registerTool({
    name: "loop_build", label: "Loop build",
    description: "在程序控制的临时副本自测；recipe_id 只能选本轮 build_profiles。不在交付目录运行构建。",
    parameters: Type.Object({recipe_id: Type.String()}),
    async execute(toolCallId, params, signal) {
      if (readonly || building) throw new Error("Build not allowed in this state");
      building = true;
      try {
        const result = await rpc("build", {recipe_id: params.recipe_id, request_id: toolCallId}, signal);
        return {content: [{type: "text", text: JSON.stringify(result)}], details: result};
      } finally { building = false; }
    }
  });
  pi.registerTool({
    name: "loop_submit_check", label: "Loop submit boundary",
    description: "调用与实际交付完全相同的边界检查。不宣称门禁或评审通过。",
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      const result = await rpc("submit_check", {}, signal);
      return {content: [{type: "text", text: JSON.stringify(result)}], details: result};
    }
  });
  pi.registerTool({
    name: "loop_delete", label: "Loop delete",
    description: "删除本单元可修改范围内已存在的普通文件，可一次多个；路径相对 code_path。不删目录；受保护文件和构建产物会被拒绝。",
    parameters: Type.Object({paths: Type.Array(Type.String(), {minItems: 1, maxItems: 500})}),
    async execute(_id, params, signal) {
      if (readonly || building) throw new Error("File operation not allowed in this state");
      const result = await rpc("delete", {paths: params.paths}, signal);
      return {content: [{type: "text", text: JSON.stringify(result)}], details: result};
    }
  });
  pi.registerTool({
    name: "loop_copy", label: "Loop copy",
    description: "把 code_path 内一个文件逐字节复制到一个或多个目标（目标须在本单元可修改范围内，已存在则覆盖）。多处必须保持完全一致的文件，改好一份后用它同步其余各份。",
    parameters: Type.Object({source: Type.String(), targets: Type.Array(Type.String(), {minItems: 1, maxItems: 500})}),
    async execute(_id, params, signal) {
      if (readonly || building) throw new Error("File operation not allowed in this state");
      const result = await rpc("copy", {source: params.source, targets: params.targets}, signal);
      return {content: [{type: "text", text: JSON.stringify(result)}], details: result};
    }
  });
  const writeTools = ["edit", "write", "loop_build", "loop_delete", "loop_copy"];
  pi.on("session_start", async () => {
    await rpc("hello");
    pi.setActiveTools(readonly ? ["read", "grep", "find", "ls", "loop_submit_check"] :
                      ["read", "grep", "find", "ls", ...writeTools, "loop_submit_check"]);
  });
  pi.on("cache_warming_decision", async () => ({action: "stop"}));
  pi.on("tool_call", async (event) => {
    const name = event.toolName;
    if (!["read", "grep", "find", "ls", ...writeTools, "loop_submit_check"].includes(name))
      return {block: true, reason: "受管成员不提供任意命令。使用 loop_build / loop_delete / loop_copy 或记录缺能力。"};
    if ((name === "loop_delete" || name === "loop_copy") && (readonly || building))
      return {block: true, reason: "当前只读或构建中，禁止修改"};
    if (name === "edit" || name === "write") {
      if (readonly || building) return {block: true, reason: "当前只读或构建中，禁止修改"};
      const input = event.input as {path?: string};
      if (typeof input.path !== "string") return {block: true, reason: "缺少明确文件路径"};
      const path = resolve(c.code_path, input.path);
      let ancestor = path;
      while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
      const real = realpathSync(ancestor);
      const relReal = relative(realpathSync(c.code_path), real);
      const rel = relative(c.code_path, path).split("\\").join("/");
      const profiles = c.execution_profiles || {};
      const outputs = (c.unit.build_profiles || []).flatMap((x: string) => profiles[x].output_paths);
      if (isAbsolute(rel) || rel.startsWith("../") || relReal.startsWith("../") || isAbsolute(relReal) ||
          !match(rel, c.unit.writable_paths) || match(rel, c.unit.protected_paths) || match(rel, outputs))
        return {block: true, reason: "超出本轮源码授权，或尝试写入临时构建产物"};
    }
  });
}
