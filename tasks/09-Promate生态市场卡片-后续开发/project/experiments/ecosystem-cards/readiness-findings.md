# host-ready：当前原装宿主名称、身份与隔离调查

绑定：`promate-ecology-cards-02-20261002T020406-04362206` / `host-ready` / `developer-r001-b84279cb5d8a`。
工作副本：`/Users/Admin/Desktop/loop/loop-data/checkouts/promate-ecology-cards-02-20261002T020406-04362206/host-ready/developer-r001-b84279cb5d8a`。

本文件是本轮开发调查，不是独立评审或业务通过证明。旧第三候选、旧日志及旧评审均不继承 PASS；issue_history 本轮为空。改名保持身份待定；正确中文名称及 1.0.0 → 1.0.1 同身份升级仍必须验证。

## 1. 本轮只读来源与版本

新入口 `integration/readiness-inspect.mjs` 只读取授权的 `/Applications/WorkBuddy.app/Contents`：以现有 `host-source.mjs` 的只读 ASAR 读取函数取当前源码，不运行旧 host-contract/research 脚本主程序、不读任何用户 profile、账号、Key、会话或默认配置。

`readiness-source.json` 保存本轮 attempt/run、采集时间、每个原装文件 SHA-256、完整所需原生片段和 UTF-16 字符偏移，供独立只读核对。本轮读取版本为 **5.6.2**；同版本不能代替文件身份核对：

- `Info.plist`：`1b7aeac8793e8cd61e1975222714a0f576197a454f5085c05692f0ee6468b7e2`
- ASAR JSON header：`72df4e8ec84f4058b33df8357abd5a6c0bf18c67cd1d750e8b7c35cd5d6ac21c`
- 原装 CLI bundle：`b340564b2410d99846397776a25fd99e11d86647a7c219ad06fedc441e364ddd`
- 原生桌面服务 `main/server.js`：`ba99f1dc4ca233d25d5cb1f68273b1c07e3fce96b151bed0f524ba5adcf1fef6`
- 面板 `renderer/assets/plugins-xKLHRllH.js`：`1beb4a72406c23354ac6256a84410952ddf59e7003703b74dbe47934c9d474d1`
- UI `renderer/assets/lib-chat-ui-C7y1ZM_R.js`：`ae57e8dc763ad67a82bc39979d096d58ebc0548cb3bf0f521de9c76727393c09`

这是当前静态读取，不是旧 displayName 假设的复述。桌面预检另记录当前宿主源码，并复核 plist/header/CLI 测试前后不变；不修改宿主包、签名、安全开关或全局权限。

## 2. 名称和安装身份的原生链

以下片段均在 `readiness-source.json` 的 sources 中，有文件摘要和原始上下文；静态链不冒充实际 IPC/桌面运行。

1. **目录市场读取**：当前 `main/server.js` 的 `DirectoryMarketplace.loadPluginList`（偏移 4601384）读取 `marketplace.json.plugins`，调用支持该 source 的 installer.isInstalled。初始复制 `pluginEntry`；找到本地清单时再读 `plugin.json`、将清单字段覆盖到 pluginInfo。CLI 的相同路径位于偏移 5783414。因此清单与市场条目的 `name` 必须协调，不能只看生成接口的返回值。
2. **已安装读取**：`getInstalledPluginsForWorkspaceState`（4805350）读取 registry.plugins 与启用设置，以 `@` 分解安装键，读取 installPath 下清单；最终 **`name: candidate.name` 覆盖清单 name**。给安装后的 plugin.json 单独加 displayName/中文 name，不能作为已安装标题正确的依据。
3. **原生控件桥**：`preload/index.js` 的 `PLUGIN_RPC_CHANNELS` 与 `PLUGIN_CHANNEL_MAP` 把 getInstalledPlugins/getMarketplacePlugins/installPlugins/updatePlugin 映射到 `plugin:getInstalled`、`plugin:getMarketplacePlugins`、`plugin:install`、`plugin:update`。`main/server.js` 的 `registerPluginHandlers`（4958975 附近；精确值见 JSON）将调用交给 deps.pluginService。没有实际调用结果时，不宣称本轮桥已成功运行。
4. **面板字段**：`loadInstalledPlugins`（13830）与 `loadMarketplacePlugins`（15267）原样映射 **`name: p.name`**，没有映射 displayName；当前该面板文件 `displayName` 出现次数为 0。
5. **真实 UI 标题**：UI 的 `.cb-plugins-card-name`（10700047）和 `.cb-plugin-detail-title`（10680254）都渲染 **`plugin.name`**。React 等其它代码里出现 displayName，不能证明卡片支持它。
6. **操作身份**：面板 `handleInstall` 使用 `adapter.installPlugins([plugin.name], marketplaceId, scope)`；`handleUpdate` 使用 `adapter.updatePlugin(plugin.name, marketplaceId)`。市场展示名会通过 `resolveMarketplaceId` 查到 **市场** storageName；它不是插件 displayName 到 resourceId 的转换。
7. **安装/升级键**：桌面服务 `getPluginId(pluginName, marketplaceName)`（4720175）返回 **`${pluginName}@${marketplaceName}`**；installPlugins 在当前提交的市场下用该键，updatePlugins（4823923）复用这个键查旧记录与新版条目。CLI 的 getPluginId/installPlugins/updatePlugins 亦一致。resourceId 只是本实验的生成/归属信息，没有在这条原生链中被当作独立插件安装键。

### 新发现：中文 name 不能直接当作已支持的修复

当前桌面 `PLUGIN_NAME_PATTERN`（4396047）为 `^[A-Za-z0-9][-A-Za-z0-9._]*$`；`assertSafePluginName`（4397593）据此拒绝不合法名字。**LocalPluginInstaller**（4420210）支持字符串相对 source，在 install、update、isInstalled 均校验 pluginEntry.name。原装 CLI 对应函数也一样。

`Loop 空壳卡片` 含空格和中文，不满足该校验。这是当前只读源码证实的必要接法限制，不是实际安装失败回执；也不证明所有可能原生接法都不存在。不能把 name 直接改为中文便宣称可安装；不能用英文、摘要或截断标题替代名称要求。

当前生成器确实将 resourceId 摘要放进 name，把中文放进 displayName。已检查路径不使用 displayName 作标题，故不能认定它正确。生成器、状态读取器和 fs-safety 本单元保持原样；**业务修复不替代环境确认**。

## 3. 当前已证实与未知

| 项目 | 本轮结论及边界 |
| --- | --- |
| 当前原装文件身份、上述名称/安装/升级静态读取链 | 已重新读取并保存，不引用旧 PASS |
| displayName 在已检查卡片面板路径起作用 | 无支持事实；该路径使用 name |
| 中文 name 直接用于本机目录 Local installer | 有明确 ASCII 校验限制；未执行安装 |
| 正确名称且同身份升级的受支持接法 | 未证实；原生标题/身份映射和上述限制需要同时满足 |
| 改名保持身份 | 本轮待定，不列为通过条件，不声称已支持 |
| 受保护真实窗口、可见市场及真实截图 | 必须以本轮前台 preflight 原始报告为准；静态源码、探针和空快照均不构成通过 |
| 七步业务、操作期间非目标资源保护、用户业务体验 | 本单元不执行，全部未验证 |
| 独立评审 | 尚未发生；开发自评不是 H4 通过依据 |

## 4. 本轮预检接法与停止策略

新增 **同一入口的 `--preflight-only`**，复用 `createIsolation`、`ManagedDesktop`、CDP 原生控件操作、原始窗口截图和精确 PID/启动时间清理，不建立第二套宿主框架。

- 在任何候选/宿主检查之前写 UNKNOWN 报告；随后保存候选 dev/ino/uid、完整文件摘要、当前工作目录和宿主摘要。
- 新建受管 `/private/tmp/loop-card-host-*`：HOME/profile/user-data/workspace 均 0700、无链接、空目录，记录身份，不借用现有用户环境。环境变量白名单不继承 Key/proxy/agent 会话。只改 HOME 或 profile 不算系统隔离。
- 先运行系统边界虚构 canary：外部读/写、链接、继承子进程、非目标 loopback/unix socket 均须拒绝；只有本次拥有的通信和根内读写可用。探针例外端口在完成后移除，真实宿主仅使用本次 CDP 端口。
- 读过本副本保存的旧原始 stderr：Chromium `sandbox initialization failed: Operation not permitted`，GPU 无法使用；旧 distinct-policy probes 连 default-only control 也被拒绝。旧证据只用于避免同一失败桌面方案原样重试。
- 最小调整是 **将当前 distinct-native-policy 兼容探针变成启动前停止条件**。它检测另一层不同策略是否真实生效，而非同策略 `/usr/bin/true` 退出零。当前前提不成立就留存原因、命令和清理，不再次启动已知不兼容的桌面；不把探针结果当桌面成功，不放宽安全边界。没有来源依据的新合法方案就停止，不随意逐条删保护规则试运气。
- 仅当前兼容前提确认后，才启动原装 Electron，校验受管监听者及原生 renderer 提供的 configDir/version；通过原生控件打开插件市场，读可见市场 header/tabs/add 控件、原生市场只读返回值和本次 on-screen 窗口截图。登录墙、不可见控件、截图权限不足等都保留 UNKNOWN，不自动登录或绕过 TCC。
- 预检不调用 generateMarket/addMarketplace/安装/启停/卸载/升级、不请求模型；原生 RPC 有只读白名单，七步 attempted 保持 false。profileBefore/After 和所有实际输出保留，不手写安装登记或修改 DOM。失败截图仅用于诊断，不能当市场可见证据。
- 预检有独立完成条件，允许在零业务步骤时判就绪；完整模式依然需要原七步和资源保护。预检 `otherResourcesUnchanged=null`，不会将空快照升级为操作保护 PASS。
- 所有运行在前台、detached=false，受管桌面按准确 PID/uid/启动时间退出；所有 bounded 探针等待 close。保留隔离根、owner token、日志及恢复记录，不删除未知目录，不 killall，不干预其它运行。

若本轮原生兼容前提仍不满足，`blocked=true` 意味本轮授权环境下不能继续，不要求证明所有合法路径都不可能。独立 OS 测试账号/桌面会话或 VM、必要权限/凭据没有在本轮提供，不擅自创建或请求；本轮不业务返修、不安装依赖、不发布。

## 5. 本轮证据和定向自检入口

前台开发预检（不伪造 H0/G1 回执）：在上述工作目录执行

```sh
/Users/Admin/.hermes/node/bin/node experiments/ecosystem-cards/integration/index.mjs \
  --workspace /Users/Admin/Desktop/loop/loop-data/runs/promate-ecology-cards-02-20261002T020406-04362206/units/host-ready/attempts/developer-r001-b84279cb5d8a/selfcheck-preflight \
  --report /Users/Admin/Desktop/loop/loop-data/runs/promate-ecology-cards-02-20261002T020406-04362206/units/host-ready/attempts/developer-r001-b84279cb5d8a/selfcheck-preflight/preflight-result.json \
  --preflight-only
```

以上是本轮证据入口，不是要求用户等待或重试已失败方案。原始 `preflight.json`、boundary、sandbox-nesting、current host-source、stdout/stderr、recovery 与可能实际获取的 PNG 在报告中的 evidenceRoot；PNG 不存在就表示没有真实截图。故障报告记录 plannedLaunch 与 actualLaunch 的区别，未启动不是启动成功。

定向自检为 `integration/preflight-test.mjs`（候选身份/两模式早期失败留证）、`integration/preflight-mode-test.mjs`（预检独立完成条件、只读 RPC、启动前阻断、环境白名单）及现有 `integration/resource-protection-test.mjs`（完整模式保护判定不降低）。逻辑 fixture 的 PASS 仅是程序检查，不是桌面 PASS。实际输出见本轮 workspace 的 `selfcheck-tests/`；最终开发响应按本轮原始结果逐条报告，不写开发方 gate: 引用。

修改仅限 integration/、本调查和 readiness-source.json；完整范围核对见本轮 workspace 的 `selfcheck-scope.json`。acceptance、reference、生成器、状态读取器、fs-safety、规则和历史材料均保持原样。引擎门禁和独立评审只能由引擎随后运行，不能拿本文件代替它们。
