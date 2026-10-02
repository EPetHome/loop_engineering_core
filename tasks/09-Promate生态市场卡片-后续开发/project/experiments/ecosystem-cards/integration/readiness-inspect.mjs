// Read only the explicitly authorized installed app. Never execute its research scripts or consult a user profile.
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readHostArchive } from '../host-source.mjs';
import { requireSafe } from '../fs-safety.mjs';
import { APP } from './isolation.mjs';
import { sha } from './evidence.mjs';

const anchors = {
  'renderer/assets/lib-chat-ui-C7y1ZM_R.js': [
    ['className: "cb-plugins-card-name"', 80, 200],
    ['className: "cb-plugin-detail-title"', 80, 200],
    ['className: "cb-plugins-header"', 120, 550],
    ['className: "cb-plugins-marketplace-tabs"', 80, 550],
    ['className: "cb-plugins-marketplace-add-btn"', 80, 400],
  ],
  'renderer/assets/plugins-xKLHRllH.js': [
    ['const resolveMarketplaceId =', 0, 300],
    ['const loadInstalledPlugins =', 0, 1550],
    ['const loadMarketplacePlugins =', 0, 1300],
    ['adapter.installPlugins([plugin.name]', 180, 350],
    ['const handleUpdate =', 0, 650],
  ],
  'preload/index.js': [
    ['GET_INSTALLED: "plugin:getInstalled"', 80, 850],
    ['getInstalledPlugins: invoke(PLUGIN_RPC_CHANNELS.GET_INSTALLED)', 100, 1150],
    ['electron.contextBridge.exposeInMainWorld("__wbInvoke", exposedWbInvoke)', 120, 250],
  ],
  'main/server.js': [
    ['function registerPluginHandlers(registry, deps)', 0, 2400],
    ['async loadPluginList()', 0, 2100],
    ['getPluginId(pluginName, marketplaceName)', 0, 450],
    ['async installPlugins(pluginNames, marketplaceName, options)', 0, 1700],
    ['async updatePlugins(pluginNames, marketplaceName, options)', 0, 2800],
    ['function assertSafePluginName(name)', 250, 450],
    ['var LocalPluginInstaller = class', 0, 3500],
    ['PLUGIN_NAME_PATTERN =', 0, 200],
    ['async getInstalledPluginsForWorkspaceState(', 0, 4800],
  ],
  'main/code-cache.js': [
    ['function resolveWorkbuddyConfigDir()', 0, 350],
    ['function getWorkbuddyUserDataDir()', 0, 250],
  ],
  'main/index.js': [
    ['function createSecureWebPreferences(kind, options = {})', 0, 1400],
    ['function applyCliCommandLineSwitches(deps)', 0, 1150],
    ['function runEarlyPreflightAndMaybeBail()', 0, 1500],
    ['WORKBUDDY_CONFIG_DIR: platform.configDir', 180, 700],
    ['const gotTheLock = electron.app.requestSingleInstanceLock();', 80, 300],
  ],
};
const cliPath = 'Resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs';
const cliAnchors = [
  ['getPluginId(ei,ea){return`${ei}@${ea}`}', 0, 400],
  ['async loadPluginList(){', 0, 1500],
  ['let tJ=/^[A-Za-z0-9][-A-Za-z0-9._]*$/', 0, 1000],
  ['let i3=class{support(ei){return"string"==typeof ei||ei.source===tD.R7.Local}', 0, 2300],
  ['async installPlugins(ei,ea,es)', 0, 1400],
  ['async updatePlugins(ei,ea,es)', 0, 2100],
];
function excerpt(text, [anchor, before, after]) {
  const offset = text.indexOf(anchor);
  requireSafe(offset >= 0, 'CURRENT_HOST_ANCHOR_MISSING:' + anchor);
  return { anchor, offset, offsetUnit: 'UTF-16 code units',
    raw: text.slice(Math.max(0, offset - before), offset + anchor.length + after) };
}
export function inspectCurrentHost() {
  const archive = readHostArchive(Object.keys(anchors));
  const plist = readFileSync(join(APP, 'Info.plist'), 'utf8');
  const cli = readFileSync(join(APP, cliPath), 'utf8');
  const main = archive.entries['main/index.js'].text;
  const panel = archive.entries['renderer/assets/plugins-xKLHRllH.js'].text;
  const server = archive.entries['main/server.js'].text;
  const sources = Object.entries(anchors).map(([path, list]) => ({
    path: 'Resources/app.asar/' + path, sha256: archive.entries[path].sha256,
    excerpts: list.map(anchor => excerpt(archive.entries[path].text, anchor)),
  }));
  sources.push({ path: cliPath, sha256: sha(cli), excerpts: cliAnchors.map(anchor => excerpt(cli, anchor)) });
  const preferences = excerpt(main, anchors['main/index.js'][0]).raw;
  const local = excerpt(server, anchors['main/server.js'][6]).raw;
  const pattern = /^[A-Za-z0-9][-A-Za-z0-9._]*$/;
  return {
    capturedAt: new Date().toISOString(), kind: 'CURRENT installed host static source; NOT desktop or install evidence',
    authorizedReadRoot: APP,
    hostVersion: /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] || null,
    hostBundleVersion: /<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] || null,
    infoPlistSha256: sha(plist), asarHeaderSha256: archive.headerSha256,
    sources,
    observed: {
      panelDisplayNameOccurrences: panel.split('displayName').length - 1,
      cardAndDetailTitleUseName: true, installedAndMarketplacePanelCopyNameVerbatim: true,
      nativeIdUsesNameAtMarket: true, updateUsesSameNameAtMarket: true,
      displayNameHonoredOnInspectedPanelPath: false,
      localNamePattern: pattern.source,
      originalChineseProbe: { name: 'Loop 空壳卡片', acceptedByLocalNamePattern: pattern.test('Loop 空壳卡片') },
      localInstallerChecksNameOnInstallAndIsInstalled: local.includes('assertSafePluginName(pluginName)')
        && local.includes('assertSafePluginName(pluginEntry.name)'),
      mainWindowNativeProtectionConfigured: /case "main": return \{[\s\S]*?contextIsolation: true,[\s\S]*?sandbox: true,[\s\S]*?nodeIntegration: false/.test(preferences),
      macOSDoesNotUseWindowsNoSandboxBranch: excerpt(main, anchors['main/index.js'][1]).raw
        .includes('if (process.platform === "win32") {\n\t\telectron.app.commandLine.appendSwitch("no-sandbox");'),
    },
    unknown: [
      '真实窗口、市场可见、中文卡片安装及同身份升级尚须本轮隔离桌面验证。',
      '尚无已证实的显示名称与插件安装键分离接法；改名保持身份本轮待定。',
      '目录源直接以中文 name 接入已检查的 LocalPluginInstaller 会遇到 ASCII 名称校验；未执行安装验证，不据此断言所有其它原生接法不可能。',
    ],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [output, attempt_id, run_id] = process.argv.slice(2);
  requireSafe(output && attempt_id && run_id, 'READINESS_OUTPUT_AND_BINDING_REQUIRED');
  const expected = resolve('experiments/ecosystem-cards/readiness-source.json');
  requireSafe(resolve(output) === expected, 'READINESS_OUTPUT_OUTSIDE_ALLOWED_PATH');
  const result = { attempt_id, run_id, sourceCodeRoot: realpathSync(process.cwd()), ...inspectCurrentHost() };
  writeFileSync(expected, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ output: expected, hostVersion: result.hostVersion, sources: result.sources.length,
    observed: result.observed, kind: result.kind }));
}
