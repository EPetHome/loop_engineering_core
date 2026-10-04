# Loop 0.4.0：AI 使用入口（先读本页）

Loop 是本地开发循环：用户定目标，AI 做准备，Loop 程序管住执行。执行包括开发、自测、门禁、独立评审和有限返修，停止后交出结果。达标不等于用户已验收，Loop 也不会自动合并原项目。

## 分工

| 谁 | 做什么 |
|---|---|
| 用户 | 头脑风暴时定目标和验收口径；启动时看预览、输入 `yes`；最终验收 |
| AI（你） | 其余全部：起草业务验收脚本和登记配置、执行登记、准备任务、把启动命令交给用户 |
| Loop | 校验配置、封存规则、管预算、调度成员、跑门禁、留证据、出结果 |

你**不能**替用户启动：不执行 `launch`，不用 `--approve`。

## 硬规则

1. **只写业务断言。** Loop 已经保证的不要再写：文件边界、指纹、候选绑定、证据留存、准备检查。验收脚本不许 `import loop_engineering`，也不许依赖 Loop 内部目录名（如 `registrations/`、`execution-NNN`）。
2. **不乱建文件。** 只在用户指定的位置新建或修改文件；不额外写报告、测试、说明。
3. **安全模式用 `audit-only`**（用户 2026-10-03 决定）。不要改回 strict。
4. **模型**：开发 `openai-codex/gpt-6.1-sol` + `max`；评审 `openai-codex/gpt-6-astra` + `xhigh`。不擅自更换或降级。
5. **说明文字不能和 plan 字段矛盾。** `notes`、项目里的 AGENTS.md 等会原样交给成员。2026-10-03 的教训：`notes` 写着 strict，实际是 audit-only，开发方发现矛盾后停止。
6. **有任务在运行时，不要改** `engine/`、`adapters/`、`extensions/`、`plugins/` 和根目录脚本；运行中的完整性检查会把这种改动当成篡改并停止运行。要改引擎，先读 `engine/AGENTS.md`。
7. 遇到规则冲突或缺少能力，如实说明，不在现场改引擎。

## 流程与命令

```
① 头脑风暴 → ② 写业务验收脚本 + plan.json → ③ 登记 register → ④ 准备 begin→patch→check→seal → ⑤ 启动命令交给用户
```

```bash
cd /Users/Admin/Desktop/loop
PY=/opt/homebrew/bin/python3.12
STATE="$HOME/.loop040/state"     # 账本：登记、准备、授权
DATA="$HOME/.loop040/data"       # 运行记录；必须在源码目录之外

$PY loop_guard.py --state "$STATE" register <项目ID> /绝对路径/plan.json --root "$DATA"
$PY loop_guard.py --state "$STATE" begin <项目ID>
$PY loop_guard.py --state "$STATE" patch <prep_id> changes.json --revision <N>   # 只在需要修改任务内容时
$PY loop_guard.py --state "$STATE" seal <prep_id> --revision <N>                  # seal 会重新检查；不要依赖缓存的 check 结果
```

- `register`、`launch` 要在**宿主环境**执行，不要放在 AI 工具自带的沙箱里。
- 项目 ID 不能覆盖；构建命令、输出、模型或可修改范围有变化时，换一个新 ID 重新登记。源码内容变了不用重新登记。
- 启动命令由 `seal` 返回，交给用户执行。用户看预览、输入 `yes` 后开始运行。
- **中途停下的多单元运行**：`$PY loop_guard.py --state "$STATE" continue <运行编号> --root "$DATA" --project-id <新ID> --out <新计划.json>` 自动起草续接计划（去掉已达标单元、从续接单元最新候选接着做、带上未解决问题），再按上面登记、准备。不要手写续接计划。

## 准备速查

准备阶段（`begin → patch → check → seal`）只看这一节，不用去读引擎源码。以下都是当前代码里真实存在的规则：

- **占位符（v2）**：配方 `execution_profiles` 的 `argv` 支持 `{python}`、`{engine}`、`{code}`、`{workspace}`、`{cache}`（该配方声明 `cache_dir` 之后才能用 `{cache}`）；成员 `argv` 支持 `{python}`、`{engine}`、`{code}`、`{workspace}`、`{context}`、`{response}`、`{schema}`、`{role}`、`{unit}`，不含 `{cache}`；v2 门禁必须写 `profile` 引用配方（登记时把配方 `argv` 复制给门禁），替换集合与配方一致——`{unit}` 只在成员 `argv` 里被替换，不要在配方或门禁里使用 `{unit}`。不要发明其他占位符。
- **`output_paths` 与 `evidence_paths`**：都写项目内相对路径。本版本不支持通配符：`*`、`?`、`[]` 会被拒绝。`output_paths` 写本次构建新产生的确切文件，或以 `/` 结尾的目录；`evidence_paths` 只写确切文件名（不能以 `/` 结尾），并且必须落在声明的新输出范围内。
- **多单元必须写 `completion`**：顶层声明 `completion`，`mode` 写 `independent`（各单元独立交付）或 `integration`（集成交付，`unit` 指向最终单元）；单单元可省略。集成模式的最终单元必须直接或间接依赖所有其他单元。
- **schema v2 不支持 `reviewer_exec`**：`reviewer_exec: true` 会被直接拒绝；评审不能执行命令，机械检查必须写成门禁。
- **评审分级**：受管评审每轮的 issue 必填 `severity`。`blocking`（必须修）要有非空 `counterexample` 和真实候选文件的 `locations`（`相对路径:行` 或 `相对路径:起-止`）；`spec_refs` 可选。`advisory`（建议）不阻断、不交开发、不需要关项。标准判 FAIL 必须有对应失败门禁、仍 OPEN 的已知必须修问题，或本报告的必须修问题；只有建议时判 PASS。级别以首次提出为准，规格缺口写 `rule_gaps`，不能据此判 FAIL。
- **过线口径 `review_bar`**：v2 有 reviewer 的单元可写；去掉首尾空白后非空、最多 600 字。评审同时看到默认和单元口径，冲突时以单元为准。

  | 单元 | 怎么写 |
  |---|---|
  | 验收脚本单元 | `"review_bar": "会让正确实现被判失败的算必须修；错误实现也能通过（检查不够严）的算建议，除非涉及标准里点名的核心行为。"` |
  | 普通开发单元 | 省略，用默认口径：违反标准原文 / 可复现错误 / 破坏下游、数据或安全才算必须修；其余建议 |

- **首轮 `first_round`**：v2 默认 `develop`；`review` 表示第 1 轮只跑门禁和评审、不开发，不过再返修。必须有 reviewer；verify 单元不得写此字段。
- **自测按轮累计分配**：单元总额 C、轮数 M+1（M 为返修上限），第 r 轮累计上限 `ceil(C×min(r,M+1)/(M+1))`，没用的顺延。20 次、返修 2 次，累计是 7 / 14 / 20，不是每轮 20 次。
- **返修前留时间**：预留 `ceil((上一轮门禁秒数+评审秒数)×1.25)`；扣除后须大于 0，且至少够上一轮开发的一半。先评审轮开发用时为 0，只要求扣除后大于 0。不足则 `NOT_MET`「时间不够返修」，不开始返修；返修开发吃到预留截止则 `NOT_MET`「返修开发用完了本轮可用时间」，保留上一候选。普通阶段超时仍为 BLOCKED。四种开发工具回执有 `seconds_left`。
- **停滞判停**：v2 从第 2 轮起，本轮开始时有 OPEN 必须修问题、评审后仍未通过，且一个都没关闭，就以 `NOT_MET`「停滞」停止。旧已解决项的 UNKNOWN 重复确认、建议和遗留不计入。
- **结果页**：「建议项」列出不阻断的建议；「成本」按会话列读文件、会话内/跨会话重读、token 和代码地图，缺数据写未知。成本只展示，不设上限。
- **续轮用 `derive`**：`derive <上一轮项目ID> --project-id <新项目ID> --out <新计划.json>` 把上一轮已登记规则原样另存为新计划，不登记、不启动；`--source <目录>` 只换源码路径；`--copy-source <新目录>` 把源码复制成可写副本并把计划指向副本（有 `--source` 就复制它，否则复制上一轮登记的源码）——上一轮候选目录只读，要拿候选当新源码就用这个选项。derive 之后仍要 `register → begin → seal`。
- **续跑用 `continue`**：多单元运行中途停下后，`continue <运行编号> --root <DATA> --project-id <新项目ID> --out <新计划.json>` 自动起草续接计划：去掉已达标单元、默认取最新候选，只带未解决问题、不带 ADVISORY 或遗留。没评审过的候选自动 `first_round: "review"`；已评审候选为 `develop`。`--from-round N` 指定历史候选及其问题快照，与 `--fresh-unit` 互斥；并行分支或需要合并上游成果时明确拒绝。同样要重新登记、由用户启动。

## 写 plan.json 的要点

从 `examples040/project-template.v2.json` 起草，所有 TODO 都要替换。

- **成员**：argv 用 `{python}`、`{engine}/../adapters/pi_member.py`。开发方只有读/改/写/搜索、`loop_build`（本单元配方自测）、`loop_submit_check`、`loop_delete`、`loop_copy`（限本单元可改范围），**不能执行任意命令**；验收要求的操作必须在这个范围内，否则先补配方或调整验收。
- **配方**（构建/检查命令）：
  - 纯构建配方单独登记，不要带"缺测试类就提前退出"这类业务前置，否则登记时验证不到输出；
  - 命令写绝对路径；Maven 用 `/usr/bin/env JAVA_HOME=<JDK21> /opt/homebrew/bin/mvn -o -B -s deploy/maven-settings.xml -Dmaven.repo.local={cache} …`；
  - `cache_dir` 指向依赖种子的克隆（`cp -cR`），不要直接用种子本身；
  - `evidence_paths` 写确切的文件名，不支持通配符。
- **单元**：`writable_paths` 给最小范围；开发和集成单元用 `review_mode: independent`；分阶段的计划可以让前面的单元保护某个文件、后面的单元修改它。
- **验收标准要有终点**：不要写"覆盖全部边界""完整处理所有情况"。列成明确清单，能用程序检查的写成门禁。准备阶段会对这类写法给出提醒，预览里也会标出来。
- **一条标准只对应一个能检查的行为**：反例是 wbhost U6 一条管 112 条断言，49f48e0a 的 W1、W2 一条塞七八个并发要求。拆成独立可核对的行为；并发要求配一个能复现的门禁。
- **开发自测要快**：给开发方配快速、针对性的测试配方；全量回归只放正式门禁，避免每次局部修改都跑全量。
- **返修收敛**：v2 默认 `review_scope: "frozen"`。首轮一次列全并分级；第 2 轮起只有未解决的已知必须修、失败门禁、改动文件里的新必须修问题阻断。未改动代码的新必须修问题记「遗留发现」，建议项另列、不阻断。连续两轮「旧问题修好了、改动处又冒新问题」则提前「不收敛」；轮初 OPEN 必须修一个没关则「停滞」。`review_scope: "open"` 只取消文件冻结，不取消分级与停滞规则。
- **时限至少覆盖开发轮数**：单元 `max_seconds` 至少为 `(max_repairs+1)×stage_timeout_seconds`，否则预览会提醒可容纳约几轮；这只是开发时限下限，还要留门禁、评审和复制等开销，不是足够跑完的保证。
- **自测额度是单元总数**：默认把 `limits.max_selftests` 平均分给有构建配方的单元；个别单元可写 `max_selftests`。总数按轮累计分配，按「每轮需要的次数 × 轮数」定，没用的顺延。
- **代码地图**：开发交付可写 `code_map`（非空字符串，最多 8000 字），列修改文件、标准对应关系和取舍；返修更新上一份地图。先评审后第一次开发没有旧地图是正常情况，评审不得提供此字段。

**登记结果怎么看**：

| 结果 | 含义 |
|---|---|
| `VERIFIED` | 命令能跑，输出都在声明范围内 |
| `VERIFIED_NONZERO` | 命令真的跑了，只是业务断言没过（通常因为功能还没做） |
| 被拒绝 | 漏声明输出（一次列全）、报告缺失、一个输出都没产生、改了源码、超时、环境错误。先看 stderr，一次改全 |

### macOS 验收配方的短临时目录

真实 Mac 上的本地 socket 测试使用 `tools/macos_test_env.py` 包装 Python 验收脚本，避免受管构建的深层 TMPDIR 超过 AF_UNIX 路径上限。例如配方 argv：

```json
["{python}", "{code}/tools/macos_test_env.py", "--report", "{code}/acceptance/temp-environment.json", "{code}/acceptance.py"]
```

将脚本参数追加在最后；报告需纳入 `output_paths`（例如 `acceptance/`），业务报告仍单独声明在 `evidence_paths`。包装器不改变 cwd、HOME 或安全模式，在 `/private/tmp` 新建本次独占短目录，同步 TMPDIR/TMP/TEMP、刷新 Python 缓存并实测 socket；结束或异常时恢复环境并只清理自己的目录。SIGKILL/断电可能残留，依据报告和 owner 文件核对，不扫描删除他人的临时文件。仅适用于 macOS，其他系统应使用其本机配方；不把环境 READY 当作业务通过。

准备前确认实际 OS/工具路径、运行权限和子进程能力；先在真实 Mac、同等深度及临时 HOME 下验证配方再派发。业务断言失败和环境错误分别报告。保护验收脚本与包装器，不让开发成员修改它们；已有相同代码的回归证据可用于避免准备阶段重复长回归，最终候选门禁仍须实跑。

## 受约束的准备目录（插件）

loop-guard 插件已在 Codex 和 Claude Code 上装好。只要在 `~/.loop040/prep` 里开会话，AI 就只有 9 个准备工具，不能跑命令、不能写文件。使用前，先在一个终端启动准备服务，`--state` 必须和项目登记时用的一致：

```bash
/opt/homebrew/bin/python3.12 /Users/Admin/Desktop/loop/loop_guard.py --state "<STATE>" serve --socket ~/.loop040/g.sock
```

## 本机事实

| 用途 | 值 |
|---|---|
| Python | `/opt/homebrew/bin/python3.12` |
| Pi | `/Users/Admin/.local/bin/pi`（0.87.1） |
| JDK 21 | `/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home`（`mvn` 不设 `JAVA_HOME` 时会用 JDK 26） |
| Codex 命令行 | `/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex`（PATH 里那个 npm 版已损坏） |
| 结果 | `<DATA>/runs/<运行编号>/result.md`；运行中用 `$PY engine/loop.py status <运行编号> --root "$DATA"` 查看 |

专家团第三批（2026-10-03）使用的是它自己的状态目录和数据根：`/Users/Admin/Desktop/产品智能体交付资料/迭代思路/14-可信交付与验收改进/loop/` 下的 `guard040-state` 和 `run-data040`。

## 详细文档

`docs040/01`（架构）、`02`（安装与日常使用）、`03`（配置接口）、`04`（安全边界）。`temp/` 是用户自己的资料区，只读，不在里面生成文件。
