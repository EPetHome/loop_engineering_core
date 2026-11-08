/** 命令级 Node 进程树 I/O 证明；原命令不重放，旧输入未被消费且由完整受控树重建才可提升。 */
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { realpathSync, writeFileSync } from "node:fs";
import { dirname, delimiter, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { ExecResult } from "./git.ts";
import { HERMES_BIN } from "./config.ts";
const { plan } = createRequire(import.meta.url)("./node-output-observer.cjs") as { plan: (command: string, cwd: string, env: NodeJS.ProcessEnv, node: string) => unknown };
export interface NodeOutputReport { command: string; nonce: string; enabled: boolean; reason?: string; events: Record<string, any>[]; outputs: string[]; evidence: string }
export function nodeOutputProof(command: string, cwd: string, eligible: string[], evidenceDir: string) {
  const nonce = randomUUID(), rootActor = randomUUID(), evidence = join(evidenceDir, `node-output-${nonce}.json`), manifest = join(evidenceDir, `node-output-${nonce}.manifest.json`);
  const enabled = eligible.length > 0 && !process.env.NODE_OPTIONS && !!plan(command, cwd, { ...process.env, PATH: `${HERMES_BIN}${delimiter}${process.env.PATH ?? ""}` }, process.execPath);
  const report: NodeOutputReport = { command, nonce, enabled, events: [], outputs: [], evidence,
    ...(!enabled ? { reason: "本次无待判定旧文件，或不是可观测的 Node/Node-shebang 原入口；不因此放行输入写入" } : {}) };
  const key = randomBytes(32), candidates = new Set(eligible); let channel = "", overflow = false;
  const preload = `--require=${JSON.stringify(join(dirname(fileURLToPath(import.meta.url)), "node-output-observer.cjs"))}`;
  if (enabled) writeFileSync(manifest, JSON.stringify({ nonce, cwd, eligible, rootActor, node: realpathSync(process.execPath), preload }), { mode: 0o600, flag: "wx" });
  const env: NodeJS.ProcessEnv = enabled ? { NODE_OPTIONS: preload, LOOP_NODE_OUTPUT_KEY: key.toString("base64"), LOOP_NODE_OUTPUT_MANIFEST: manifest,
    LOOP_NODE_OUTPUT_FD: "3", LOOP_NODE_OUTPUT_ACTOR: rootActor, LOOP_NODE_OUTPUT_PARENT: "" } : {};
  const onControl = enabled ? (chunk: string): void => { if (channel.length + chunk.length > 8 * 1024 * 1024) overflow = true; else channel += chunk; } : undefined;
  const finish = (result: ExecResult): NodeOutputReport => {
    try {
      if (!enabled) return report;
      if (overflow || result.killed || result.processesReleased !== true) throw new Error("Node I/O 证据不完整或消费者未确认释放");
      const messages = new Map<string, { actor: string; seq: number; signature: string; parts: string[]; count: number; position: number }>();
      let position = 0;
      for (const line of channel.split("\n").filter(Boolean)) {
        const match = /^LOOP_NODE_OUTPUT_V2 ([a-f0-9-]{36}) (\d+) (\d+)\/(\d+) ([A-Za-z0-9+/=]+) ([a-f0-9]{64})$/.exec(line);
        if (!match) throw new Error("Node I/O 通道有非协议数据");
        const [, actor, rawSeq, rawPart, rawCount, data, signature] = match, seq = Number(rawSeq), part = Number(rawPart), count = Number(rawCount), id = `${actor}:${seq}`;
        if (!Number.isSafeInteger(seq) || seq < 1 || count < 1 || count > 128 || part < 1 || part > count) throw new Error("Node I/O 分片范围无效");
        const message = messages.get(id) ?? { actor, seq, signature, parts: [], count, position: position++ };
        if (message.signature !== signature || message.count !== count || message.parts[part - 1] !== undefined) throw new Error("Node I/O 分片重复或冲突");
        message.parts[part - 1] = data; messages.set(id, message);
      }
      const actors = new Map<string, Record<string, any>[]>(), ordered: { event: Record<string, any>; position: number }[] = [];
      for (const message of [...messages.values()].sort((a, b) => a.actor.localeCompare(b.actor) || a.seq - b.seq)) {
        if (Array.from({ length: message.count }, (_, i) => message.parts[i]).some((p) => p === undefined)) throw new Error("Node I/O 分片缺失");
        const payload = Buffer.from(message.parts.join(""), "base64").toString("utf8"), entries = actors.get(message.actor) ?? [], previous = entries.at(-1);
        const signature = createHmac("sha256", key).update(previous?.signature ?? "").update(payload).digest("hex");
        const event = JSON.parse(payload);
        if (signature !== message.signature || event.actor !== message.actor || event.seq !== entries.length + 1 || event.nonce !== nonce
          || !Number.isSafeInteger(event.pid) || event.pid < 2 || previous && event.pid !== previous.pid) throw new Error("Node I/O 签名/进程/顺序不匹配");
        if (!["begin", "end", "read", "replace", "opaque", "delegate", "spawn-result"].includes(event.type)) throw new Error("Node I/O 事件类型未知");
        entries.push({ ...event, signature }); actors.set(message.actor, entries); ordered.push({ event, position: message.position });
      }
      report.events = ordered.sort((a, b) => a.position - b.position).map((v) => v.event);
      for (const entries of actors.values()) if (entries[0]?.type !== "begin" || entries.at(-1)?.type !== "end" || entries.filter((e) => e.type === "begin").length !== 1 || entries.filter((e) => e.type === "end").length !== 1) throw new Error("Node 消费者缺少完整开始/退出回执");
      const root = actors.get(rootActor);
      if (!root || root[0].parent !== "" || root.at(-1)?.code !== result.code) throw new Error("未取得原入口的退出回执");
      if (report.events.some((e) => e.type === "opaque")) throw new Error("命令包含未完整观测的消费者/原输入移动，不授权旧文件改写");
      const delegates = new Map<string, Record<string, any>>(), results = new Map<string, Record<string, any>>();
      for (const event of report.events) {
        if (event.type === "delegate") { if (delegates.has(event.child) || event.child === rootActor) throw new Error("Node 委派身份重复"); delegates.set(event.child, event); }
        if (event.type === "spawn-result") { if (results.has(event.child)) throw new Error("Node 启动回执重复"); results.set(event.child, event); }
      }
      for (const [child, spawned] of results) if (!delegates.has(child) || delegates.get(child)!.actor !== spawned.actor) throw new Error("Node 启动回执没有对应委派");
      for (const [child, edge] of delegates) {
        const spawned = results.get(child), entries = actors.get(child);
        if (!spawned || spawned.actor !== edge.actor || spawned.started !== !!entries || entries && entries[0].parent !== edge.actor) throw new Error("Node 子消费者委派/启动/退出不完整");
      }
      for (const [id, entries] of actors) {
        if (id === rootActor) continue;
        const edge = delegates.get(id); if (!edge || edge.actor !== entries[0].parent) throw new Error("Node 消费者没有本次委派");
        const seen = new Set([id]); let cursor = edge.actor;
        while (cursor !== rootActor) { if (seen.has(cursor) || !delegates.has(cursor)) throw new Error("Node 消费者树不完整"); seen.add(cursor); cursor = delegates.get(cursor)!.actor; }
      }
      const read = new Set<string>(), produced = new Set<string>();
      for (const event of report.events) {
        if (event.type !== "read" && event.type !== "replace") continue;
        if (!candidates.has(event.path)) throw new Error("Node I/O 路径不属于本次旧文件");
        if (event.type === "read" && !produced.has(event.path)) read.add(event.path);
        if (event.type === "replace" && !read.has(event.path)) produced.add(event.path);
      }
      report.outputs = [...produced]; report.reason = "本次完整 Node 消费者树证明：替换前未消费原内容";
    } catch (error) { report.outputs = []; report.reason = String(error); }
    finally { writeFileSync(evidence, JSON.stringify(report, null, 2), { mode: 0o600 }); key.fill(0); }
    return report;
  };
  return { env, onControl, finish };
}
