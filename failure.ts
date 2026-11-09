/** 受管命令失败的归因。未知原因不消耗业务返修预算，也不能被当作通过。 */
export type FailureKind = "product" | "environment" | "method" | "unknown";

export interface Failure {
  kind: FailureKind;
  reason: string;
}

/** 测试标题/通过项、引用、代码样本和 expected/actual 都不是当前故障来源。 */
function failureLines(output: string): string[] {
  let fence: string | undefined;
  return output.split(/\r?\n/).flatMap((raw) => {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, "").trim();
    const fenced = /^(?:#\s*)?(`{3,}|~{3,})/.exec(line);
    if (fenced) { if (!fence) fence = fenced[1][0]; else if (fence === fenced[1][0]) fence = undefined; return []; }
    if (fence || /^(?:#\s*)?(?:Subtest:|ok\s+(?:\d+\b|-)|PASS\b|\[PASS\]|[✓✔])|^[>"'`]/.test(line)
      || /(?:\.\.\.\s*ok|\.{2,}\s*PASSED|\s+PASSED(?:\s+\[.*\])?)\s*$/i.test(line)) return [];
    const diagnostic = line.replace(/^#\s?/, "").replace(/^E\s+/, ""); // TAP/pytest 的真实错误输出包装。
    if (/^(?:expected|actual|received|sample|example|quote|样本|示例|引用)\s*[:：=]/i.test(diagnostic)) return [];
    return diagnostic ? [diagnostic] : [];
  });
}
/** 只认有错误来源的诊断，不对整份输出任意位置的 ENOSPC 做匹配。 */
function storageError(line: string): boolean {
  if (/^(?:Error|OSError|IOError|SystemError)\s*\[ENOSPC\]:/i.test(line)) return true;
  const error = /^(?:\[)?(?:(?!AssertionError\b)[\w.$]*(?:Error|Exception)):\s*(.*)$/i.exec(line)
    ?? /^(?:\d{4}-\d\d-\d\d\S*\s+)?(?:ERROR|FATAL|\[ERROR\]|\[FATAL\])(?:\s+|:\s*)(.*)$/i.exec(line)
    ?? /^(?:npm ERR!|(?:bash|sh|zsh|cp|mv|tee|mkdir|mktemp|touch|dd|tar|git|mc):)\s*(.*)$/i.exec(line)
    ?? /^(?:write|open|mkdir|rename|fsync)(?:\s+(?:failed|error))?:\s*(.*)$/i.exec(line);
  if (error && !/^(?:expected|actual|received|sample|example|quote)\b/i.test(error[1])) {
    return /^(?:\[Errno\s+28\]\s*)?ENOSPC\b|\bNo space left on device\b|\bdisk full\b|Storage backend has reached its minimum free drive threshold|No usable temporary directory found|^(?:code\s+|(?:write|open|mkdir|rename|unlink|fsync)\b[^\n]*)ENOSPC\b/i.test(error[1]);
  }
  return /^ENOSPC:\s*(?:no space left on device|disk full)\b/i.test(line);
}

/** 75/78 为脚本声明；真实存储错误优先，其余相矛盾的声明/诊断保守记未知。 */
export function classifyFailure(code: number, output: string, interrupted = false): Failure {
  const lines = failureLines(output), diagnostics = lines.join("\n");
  const marked = lines.filter((line) => /^AUTOREVIEW_FAILURE=(product|environment|method|unknown)(?:[ \t]+[^\r\n]*)?$/.test(line));
  const declared = marked.map((line) => ({ kind: /^AUTOREVIEW_FAILURE=(\w+)/.exec(line)![1] as FailureKind, source: line }));
  const exitKind: FailureKind | undefined = [75, 126, 127].includes(code) ? "environment" : code === 78 ? "method" : undefined;
  if (exitKind) declared.push({ kind: exitKind, source: `退出码 ${code}` });
  const evidence = (line: string): string => line.slice(0, 600);
  const priority = (reason: string, line: string): Failure => ({ kind: "environment", reason: `${reason}；有效故障行：${evidence(line)}${declared.some((d) => d.kind !== "environment") ? `；冲突声明：${declared.filter((d) => d.kind !== "environment").map((d) => evidence(d.source)).join("；")}；按实际环境故障优先保护，不以衍生断言扣产品次数` : ""}` });
  if (interrupted) return { kind: "environment", reason: "命令超时或中断" };
  const storage = lines.find(storageError);
  if (storage) return priority("存储空间不足或临时目录不可用", storage);
  const port = lines.find((line) => /\bEADDRINUSE\b|(?:Error|OSError|listen|bind)[^\n]*address already in use/i.test(line));
  if (port) return priority("端口已被占用", port);
  const method = lines.find((line) => /^(?:SyntaxError|ModuleNotFoundError|ImportError|FileNotFoundError):|Cannot find (?:module|package)/.test(line));
  const product = lines.find((line) => /^not ok\b|^AssertionError\b|^FAIL(?:ED|URE|URES)?(?:[\s:(]|$)|^(?:tests?|checks?) failed\b|\b\d+ (?:tests?|checks?) failed\b|error TS\d+|\[ERROR\].*(?:compilation|test failures)|^新增失败\s*[：:]\s*\S/i.test(line));
  const inferred: FailureKind | undefined = method ? "method" : product ? "product" : undefined;
  const kinds = new Set(declared.map((d) => d.kind)), first = declared[0];
  if (kinds.size > 1 || first && first.kind !== "unknown" && inferred && first.kind !== inferred) {
    return { kind: "unknown", reason: `分类证据冲突，未猜测产品责任：${declared.map((d) => evidence(d.source)).join("；")}${inferred ? `；有效${method ? "方法错误" : "产品断言/编译失败"}：${evidence(method ?? product ?? diagnostics)}` : ""}` };
  }
  if (first) return { kind: first.kind, reason: `项目命令的明确分类：${declared.map((d) => evidence(d.source)).join("；")}` };
  if (method) return { kind: "method", reason: "执行入口、依赖或检查脚本不可用" };
  if (product) return { kind: "product", reason: "程序检查报告断言、编译或回归失败" };
  return { kind: "unknown", reason: `退出码 ${code}，缺少足够证据确定责任` };
}

/** 补装只跳过项目明确声明的方法错误；文本推断的 method/unknown 不代表禁止恢复。 */
export function recoveryDecision(code: number, output: string, config: { recover?: string; maxRecoveries: number } | undefined, used: number): { allowed: boolean; reason: string; remaining: number } {
  const remaining = Math.max(0, (config?.maxRecoveries ?? 0) - used);
  if (code === 78 || failureLines(output).some((line) => /^AUTOREVIEW_FAILURE=method(?:[ \t]+[^\r\n]*)?$/.test(line))) {
    return { allowed: false, reason: "项目声明方法错误，未补装", remaining };
  }
  if (!config?.recover) return { allowed: false, reason: "未配置 recover，未补装", remaining };
  if (!remaining) return { allowed: false, reason: "补装次数用完，未补装", remaining };
  return { allowed: true, reason: "检查失败，先补装再复查", remaining };
}

/** 状态中的一行原始错误；完整输出仍留在证据日志。 */
export function failureLine(code: number, output: string): string {
  const lines = failureLines(output);
  return (lines.find((line) => /AUTOREVIEW_FAILURE=|Error|Cannot find|error|failed/i.test(line)) ?? lines[0] ?? `退出码 ${code}（无错误输出）`).slice(0, 600);
}

/** Pi 的会话创建告警不是失败原因；原始输出仍保存在调用日志中。 */
export function testerDiagnostics(output: string): string {
  return output.split(/\r?\n/).filter((line) => !/No project session found|^\s*creating a new session with that id\.?\s*$/i.test(line)).join("\n").trim();
}

/** 验收方调用故障独立于被测命令：不能把模型断线/超时算作产品失败。 */
export function classifyTesterFailure(code: number, output: string, interrupted = false, stalled = false): Failure & { disconnected?: boolean } {
  const clean = testerDiagnostics(output);
  const failure = classifyFailure(code, clean);
  // 资源释放、入口和依赖故障优先：即使已取得全部证据，也不能掩盖执行器清理失败。
  if (failure.kind === "environment" || failure.kind === "method") {
    return { ...failure, reason: `${failure.reason}${clean ? `；${clean.slice(-400)}` : ""}` };
  }
  if (stalled || interrupted || [129, 130, 137, 143].includes(code) || /Connection error|Request timed out|ECONNRESET|ETIMEDOUT|rate.?limit|too many requests|(?:HTTP|status)\s*429/i.test(clean)) {
    return { kind: "environment", disconnected: true, reason: stalled ? "验收方模型断线或挂住（连续无新动作）" : "验收方模型断线（调用超时、连接中断或限流）" };
  }
  return { kind: failure.kind === "product" ? "unknown" : failure.kind,
    reason: `验收方调用异常：${failure.reason}${clean ? `；${clean.slice(-400)}` : ""}` };
}

export const failureLabel = (kind: FailureKind): string => ({
  product: "产品缺陷", environment: "环境阻塞", method: "检查方法故障", unknown: "原因待诊断",
})[kind];
