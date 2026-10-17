/** 受管命令失败的归因。未知原因不消耗业务返修预算，也不能被当作通过。 */
export type FailureKind = "product" | "environment" | "method" | "unknown";

export interface Failure {
  kind: FailureKind;
  reason: string;
}

/** 75/78 是项目脚本可声明的环境/检查方法退出码；标记只读受管命令输出。 */
export function classifyFailure(code: number, output: string, interrupted = false): Failure {
  if (interrupted) return { kind: "environment", reason: "命令超时或中断" };
  // 明确的资源故障优先于由它引起的大量断言失败。
  if (/\bENOSPC\b|(?:OSError|IOError|Error):[^\n]*(?:No space left on device|disk full)|Storage backend has reached its minimum free drive threshold|No usable temporary directory found/i.test(output)) {
    return { kind: "environment", reason: "存储空间不足或临时目录不可用" };
  }
  if (code === 75) return { kind: "environment", reason: "项目命令报告环境阻塞（退出码 75）" };
  if (code === 78) return { kind: "method", reason: "项目命令报告准备或检查方法失效（退出码 78）" };
  if (code === 126 || code === 127) return { kind: "environment", reason: "命令不存在或不能执行" };
  const marked = /^AUTOREVIEW_FAILURE=(product|environment|method|unknown)(?:[ \t]+([^\r\n]*))?$/m.exec(output);
  if (marked) return { kind: marked[1] as FailureKind, reason: marked[2]?.trim() || "项目命令的明确分类" };
  if (/^Traceback[\s\S]*FileNotFoundError:|^(?:SyntaxError|ModuleNotFoundError|ImportError):|Cannot find (?:module|package)/m.test(output)) {
    return { kind: "method", reason: "执行入口、依赖或检查脚本不可用" };
  }
  if (/^not ok\b|\bAssertionError\b|\bFAIL(?:ED|URE|URES)?\b|\b(?:tests?|checks?) failed\b|error TS\d+|\[ERROR\].*(?:compilation|test failures)|新增失败\s*[：:]\s*\S/im.test(output)) {
    return { kind: "product", reason: "程序检查报告断言、编译或回归失败" };
  }
  return { kind: "unknown", reason: `退出码 ${code}，缺少足够证据确定责任` };
}

export const failureLabel = (kind: FailureKind): string => ({
  product: "产品缺陷", environment: "环境阻塞", method: "检查方法故障", unknown: "原因待诊断",
})[kind];
