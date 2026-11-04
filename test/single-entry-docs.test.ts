/** A7：用户文档只有统一入口；兼容脚本只能在内部实现说明中出现。 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

for (const path of ["README.md", "README-验收标准.md", "工具清单.md", "项目模板/README.md", "项目文档/运行与维护.md"]) {
  test(`A7 ${path} 不要求规则副本或回写，底层入口只在内部实现说明`, () => {
    const text = readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");
    assert.doesNotMatch(text, /复制到项目|收尾回写|已回写原单|【块 [123]】/);
    let internal = false;
    for (const line of text.split(/\r?\n/)) {
      if (/^## /.test(line)) internal = line.includes("内部实现");
      if (/loop-dev|pi-dev|pipeline\.ts|setup-acceptance/.test(line)) assert.ok(internal, `${path} 内部实现之外出现底层入口：${line}`);
    }
    assert.match(text, /bin\/loop 接入/);
    assert.match(text, /bin\/loop 开发/);
  });
}
