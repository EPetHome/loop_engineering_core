# 本机空壳卡片实验（未完成桌面验收）

仅本目录实现；无依赖安装、发布、总插件接入或业务资源。运行位置为本代码副本根目录，使用 Node 22。

## 接口

- `card-generation/index.mjs`：`await generateMarket({outputRoot, ownerId, marketName, card:{resourceId,name,description,version}})`。
  `outputRoot` 必须是明确指定的绝对目录；不存在时只创建一个已验证父目录下的目录。返回市场根、市场名、稳定插件名、资源 ID 和版本。
- `card-state/index.mjs`：`await readCardState({profile,marketName,pluginName})`。只读显式 profile 的用户级登记、启用标志和清单；不扫描 HOME、不运行 CLI、不以缓存目录猜安装。跨身份共用/侵占卡片缓存路径（含卸载后的冲突）返回 `null` 和原因；profile 内的异主路径也拒绝符号链接；profile 外的未知声明不访问、不假定无冲突。缺失启用标志时 `enabled=null`，不是默认启用。

生成例子（只创建本次专属临时目录）：

```sh
node --input-type=module <<'JS'
import {mkdtempSync} from 'node:fs';
import {generateMarket} from './experiments/ecosystem-cards/card-generation/index.mjs';
console.log(await generateMarket({outputRoot:mkdtempSync('/private/tmp/loop-card-demo-'),
  ownerId:'local-demo',marketName:'loop-ecology-demo',card:{resourceId:'demo-001',
  name:'空壳测试卡片',description:'无业务内容',version:'1.0.0'}}));
JS
```

插件包只有 `.codebuddy-plugin/plugin.json`，不含技能、代码、钩子、MCP 或脚本。`name` 是资源 ID 摘要派生的永久安装键；输入名称原样存入 `displayName`，简介和版本原样保存。`host-contract.json` 保留原装 5.6.2 源码摘要和原文片段：面板标题和安装身份都使用 `name`。尚无受支持的可变展示名称机制证据，S1 不能判通过；集成现在明确核对输入名称，摘要安装键可见不再算名称正确。

市场根的 `.loop-card-owner.json` 记录归属和文件摘要，不进入卡片包。改名、升级不改变安装键和市场根；未知归属、额外文件/目录、符号链接、破损或被修改的输出均拒绝覆盖。更新先暂存，再切换；切换异常恢复旧目录。成功更新保留市场外的隐藏 `.previous-*` 恢复副本，不注册第二市场。未知锁不自动夺取。macOS `/tmp`、`/var` 两个系统别名先转为 `/private/...`，其余路径符号链接拒绝。

## 自测与宿主入口

```sh
node experiments/ecosystem-cards/self-test.mjs
node experiments/ecosystem-cards/integration/preflight-test.mjs
node experiments/ecosystem-cards/integration/cdp-selection-test.mjs
WORKSPACE="$(mktemp -d /private/tmp/loop-card-evidence-XXXXXX)"
node experiments/ecosystem-cards/integration/index.mjs \
  --workspace "$WORKSPACE" --report "$WORKSPACE/host-result.json"
```

集成入口在前台等待并清理；每次另建 `/private/tmp/loop-card-host-*` profile/user-data，不复制账号或 Key。系统沙箱禁止真实用户目录读写、Keychain、偏好 IPC、非白名单网络和根外写入；先确认外部 canary、符号链接、子进程、loopback 与 Unix socket 正反例，再启动未改装的 WorkBuddy。仅放行本次端口及本次隔离根内的 Unix socket；`MAC_CHROMIUM_TMPDIR` 将原生 Singleton socket 放在同一根内，不取消原生锁。厂商 `WB_E2E_DISABLE_STARTUP_REPAIR=true` 避免启动修复器脱离进程组；不额外传入关闭原生沙箱的参数，截图辅助程序也受同一系统沙箱限制。

候选入口、模块与 cwd 分别拒绝符号链接，再比较 dev/ino/uid；只在文件系统身份相同的前提下接受 `Loop`/`loop` 表示差异。报告保留调用路径、实际 cwd 与身份依据；候选冲突等前置失败也写结构化报告及七步未执行说明，但未经证实的资源保护值保持 `null`。

若真实桌面可建立，流程使用其原生市场 RPC 和实际面板点击，核对原始宿主状态、只读状态、原生窗口截图、其他资源摘要及候选代码摘要。没有截图或状态证据就不通过；不会用 CLI/headless 安装、自写登记、替代 HTML 或假图补齐。只对本次记录过的 PID、UID、启动时间清理，保留隔离根、原始输出、报告和恢复材料。

## 旧轮结果（历史，不作为本轮证据）

- 已验证：47 项定向自测、只读验收脚本 `c` 模式及 Node 语法检查；覆盖空壳内容、幂等/改名/升级、未知归属、空目录侵入、符号链接、权限拒绝、注入切换失败回滚、登记矛盾/损坏与只读性。
- 已验证的宿主前置：原装 5.6.2、CLI 与 ASAR 清单摘要；沙箱的七个边界正反例通过。不是桌面操作通过。
- **宿主失败/未验证**：桌面在创建原生 Singleton socket 目录时退出，stderr 为 `Failed to create socket directory`，启动日志为 `gotTheLock=false`；没有可连接的本次桌面、没有七步操作截图。全部桌面步骤保持 UNKNOWN，集成命令非零退出。系统 Foundation 临时目录仍指向根外 `/var/folders/...`；未放宽沙箱、未使用真实 profile、未绕过锁。
- 未验证：七步真实操作、原生面板中文名称/改名、操作后的其他资源保护、冻结候选门禁和独立评审。UI 自动化分支尚未实跑，逻辑测试不等于业务验收。

旧轮自述保留在 `developer-selfcheck.json`，不冒充当前测试。

## 本轮返修结果（r002）

- 已验证：58 项生成/状态定向自测；新增跨身份相同路径、系统别名、大小写、父/旧版缓存占用、卸载后归属冲突、异主符号链接、profile 外未知归属及损坏异主登记反例。现有只读验收 `c` 样例通过。
- 已验证：候选路径身份与前置失败报告 6 项、卡片点击选择逻辑 6 项（仅逻辑 fixture，不是桌面证据）；JXA 辅助脚本在独立沙箱中运行通过。52 个受保护输入的本轮原始前后摘要见 `protected-before.json` / `protected-after.json`。
- 宿主前置已验证：真实 5.6.2 构建摘要；9 个隔离边界正反例通过，已越过旧 Singleton socket 路径/绑定问题。
- **宿主失败**：原生 Chromium GPU/网络服务报 `sandbox initialization failed: Operation not permitted`，入口记录 `NATIVE_CHROMIUM_SANDBOX_INITIALIZATION_DENIED` 并非零退出。未关闭原生沙箱、未借用真实 profile 或现有服务；本次受管进程完成清理，隔离根及原始证据保留。
- 未验证：输入名称的真实展示/改名、七步桌面操作及其截图、操作期间的其他资源保护、冻结候选门禁和新的独立评审。启动前后空登记未变化不等于七步保护通过。

本轮自检摘要在 `developer-selfcheck-r002.json`；开发原始失败报告/输出副本在 `developer-evidence-r002/`，明确不是引擎冻结候选门禁证据。宿主工作目录和恢复根在报告内保留。引擎仍须在冻结候选上运行自己的检查，开发自评不是最终结论，也不是人工业务验收。

## 最新返修（r003，仍未达标）

- 修正 S5 报告：启动失败时，空登记前后相同只记为 `diagnosticBeforeAfterUnchanged`；`otherResourcesUnchanged=null`，不能冒称七步期间资源保护通过。只有七步实际执行、原生截图/原始证据齐全、每步及最终非目标状态均未变才报告通过；操作后的原始登记也逐步保留。
- 补全 S1 名称链路的只读研究：`host-contract-r003.json` 保存当前原装 5.6.2 的源码摘要、偏移及原文。实际插件面板将市场/已装列表的 `p.name` 原样映射给标题，丢弃 `displayName`，安装亦使用 `plugin.name`。生成器保持稳定资源身份，但输入名称的原生展示问题**未修复**，不会把字段落盘当作名称通过，也不改宿主或 DOM。
- 新增原生沙箱叠加诊断：同一独立根里，单独应用更严格的内层策略确实拒绝虚构 canary；继承外层后应用不同策略返回 `sandbox_apply: Operation not permitted`。移除 process-info 限制和仅 allow-default 的控制组也拒绝；这些控制组只运行固定 canary 程序，**没有用来启动桌面**。它定位兼容性疑点，不证明所有合法接法都不存在。
- 已验证：58 项生成/只读状态自测、只读验收 `c` 样例、6 项候选前置测试、13 项资源保护报告分类测试及 8 个改动模块的 Node 语法检查。原装宿主测试前 9 个隔离边界正反例通过。
- **真实宿主仍失败**：本轮只启动一次原装桌面，前台退出 1，原始 stderr 再现 `sandbox initialization failed: Operation not permitted` 和 GPU 不可用；七步均 `attempted=false`，无截图。未添加关闭 Chromium 安全保护的启动参数。受管进程已按 PID/UID/启动时间清理，无剩余或脱离进程；必要时用了 SIGKILL，保留恢复材料。
- 未验证：输入名称/改名的实际展示、七步桌面操作、操作期间的其他资源保护，以及本轮冻结候选门禁与新的独立评审。技术自测不等于业务验收。

本轮自测摘要在 `developer-selfcheck-r003.json`，完整原始输出副本及摘要清单在 `developer-evidence-r003/`；旧轮证据未改写。真实自测原目录为 `/private/tmp/loop-card-r003-desktop-UQMctc`，恢复根为 `/private/tmp/loop-card-host-HPiR04`。复制时不重写报告中的原始路径；这是开发自测，不是引擎门禁。

附加定向诊断（在本副本根目录运行，不启动其他模型或服务）：

```sh
node experiments/ecosystem-cards/integration/resource-protection-test.mjs
WORKSPACE="$(mktemp -d /private/tmp/loop-card-nesting-XXXXXX)"
node experiments/ecosystem-cards/integration/nested-sandbox-test.mjs "$WORKSPACE"
```

`DIAGNOSTIC_COMPLETE` 仅表示诊断已前台结束；兼容性取 `distinctPolicyNestingConfirmed`，不能按诊断命令退出 0 推断桌面可用。
