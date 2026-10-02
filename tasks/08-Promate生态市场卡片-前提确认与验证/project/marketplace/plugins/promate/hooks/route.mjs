#!/usr/bin/env node
// UserPromptSubmit hook：识别疑似 Promate Key 并阻止插件保存；处理写操作的待确认；路由 Promate 问题。
//
// 输出约定（见「提示词-插件第二步」6.3、「提示词-插件写操作确认兜底」6.3）：
// - 认出 Key：stdout 仅给出安全警告，退出码 2；宿主已预先写入内存 history，不能声称安全拦截。
// - 有待确认且用户整条消息是「确认/确定」：只把 confirmed 置为 true，不输出、退出码 0。
// - 有待确认但用户说的是别的：清掉待确认，照常走路由判断。
// - 命中路由：stdout 一行 JSON（additionalContext），退出码 0。
// - 都没命中：不输出，退出码 0。
// - 新消息先追加独立代次，使旧授权失效；状态忙/异常时明确阻止当前消息，不伪装确认或取消成功。

import {
  configKey, isConfirmWord, isPendingExpired, log, readConfig, readStdinJson,
  readUserMessageHead, recordUserMessage, resolveUrl, withSessionState, writeConfigUrl, writeState,
} from './lib.mjs';

/** Key 只认 pk_ + 16 位以上字母数字；st_ 开头的会话令牌不当 Key。 */
const KEY_PATTERN = /\bpk_[A-Za-z0-9]{16,}\b/;
/** 显式开关：消息以 @promate 或 /promate 开头。 */
const EXPLICIT_PATTERN = /^\s*[@/]promate\b/i;

/** 关键词路由表：命中任一类别就注入指令；正则和工具按类别一一对应。 */
const CATEGORIES = [
  {
    name: '配置',
    tools: 'configure_key（不传任何参数，用户在本机页面自行输入 Key）',
    pattern: /Promate\s*配置\s*Key|配置\s*Promate\s*Key/i,
  },
  {
    name: '项目',
    tools: 'my_projects',
    pattern: /我(参与|负责)的?项目|哪些项目|项目\s*\d+|项目\s*(ID|编号)/,
  },
  {
    name: '需求',
    tools: 'list_requirements（projectId 可省略，按标题或编号跨可见项目搜）/ get_requirement（单条详情和具体回写任务）',
    // 「需求」和「列表/进度/状态/清单/更新」之间允许隔 0–6 个字（例如「需求现在什么状态」）。
    pattern: /需求\s*\d+|REQ-\d+|我负责的?需求|我的需求|需求(?!文档|的?状态机)[\s\S]{0,6}(列表|进度|状态(?!机)|清单|更新(?!.{0,3}格式))|有哪些需求/,
  },
  {
    name: '提醒',
    tools: 'my_alerts / get_requirement / retry_writeback（先查具体失败任务，确认后仅提交重试）',
    pattern: /我的待办|有什么(提醒|待办)|要处理(什么|的)|该跟进/,
  },
  {
    name: '产出物',
    tools: 'add_artifact / update_artifact / remove_artifact（可撤销删除）',
    pattern: /产出物|登记.{0,6}(文档|方案|原型)/,
  },
  {
    name: '状态',
    tools: 'mark_done / mark_delivered；超时先 get_requirement 查状态',
    pattern: /标记.{0,4}完成|交付研发/,
  },
  {
    name: '技能',
    tools: 'list_skills / get_skill（只读说明，不计获取）/ install_resource（安装或升级）/ uninstall_resource / my_installed / upload_skill / upload_skill_version（本机 filePath）/ my_skills（审核状态）',
    pattern: /团队技能|我(装|安装|上传)的.{0,6}技能|技能.{0,6}(怎么用|升级|审核|卸载)|(装|安装|卸载|升级|上传|发布).{0,8}技能|\/cx\b/,
  },
];

/** 按命中类别拼路由指令；显式 @promate 但没命中关键词时给通用工具说明。 */
function buildContext(prompt, config) {
  const hit = CATEGORIES.filter((category) => category.pattern.test(prompt));
  let names;
  let tools;
  if (hit.length > 0) {
    names = hit.map((category) => category.name).join('、');
    tools = [...new Set(hit.map((category) => category.tools))].join('；');
  } else {
    names = '用户显式指定 Promate';
    tools = 'promate MCP 服务的工具（按需选择）';
  }
  let context = `【Promate 路由】这条消息涉及 Promate 产品中台的数据（${names}）。请使用 promate MCP 服务的工具（${tools}），数据以 Promate 为准；`
    + '不要自己写脚本调用接口，也不要去读飞书表或使用其它需求类技能来查这些数据。拿到 Promate 的数据以后，后续加工（写文档、评审等）可以正常使用其它技能。九类写操作及旧别名 set_stage 调用前会要求对话确认实际对象和具体参数，用户须独立回复「确认」，不依赖弹窗。';
  if (!configKey(config)) {
    context += '尚未配置 Promate Key：请使用无参数的 configure_key 工具给用户打开插件本机「配置 Key」页。Key 只能由用户在该页面输入，不能放进聊天、工具参数或 URL；保存成功后仍需查询 my_projects 验证身份。';
  }
  return context;
}

let messageRecorded = false;

function main() {
  const event = readStdinJson();
  if (!event) return;
  const prompt = typeof event.prompt === 'string' ? event.prompt : '';
  const sessionId = typeof event.session_id === 'string' && event.session_id.trim()
    ? event.session_id.trim() : '';

  // 在任何短路分支和抢锁之前撤销旧代次；不能等拿到状态锁才处理取消。
  const messageId = sessionId ? recordUserMessage(sessionId) : null;
  messageRecorded = Boolean(messageId);

  if (prompt.trim() === 'Promate 拦截自检' || prompt.trim() === '/promate check-hooks') {
    process.exitCode = 2;
    process.stdout.write('Promate hook 已运行；聊天消息在 hook 前已进入宿主内存历史，请勿在聊天输入 Key。\n');
    return;
  }
  const keyMatch = prompt.match(KEY_PATTERN);
  if (keyMatch) {
    // 先标为拦截；即使保存或清理状态失败也不能泄漏到模型。
    process.exitCode = 2;
    if (sessionId) withSessionState(sessionId, (state) => {
      delete state.pendingConfirm;
      writeState(sessionId, state);
    });
    // 宿主在运行此 hook 前已将原文加入内存 history；不可再假称保存安全或仅靠 exit 2 消除原文。
    // 即使用户误发也不写入插件配置、不回显；会话可能已包含原文，应停止使用该会话并处理泄漏。
    process.stdout.write('检测到疑似 Promate Key：插件未保存。WorkBuddy 聊天原文可能已进入会话历史，请勿继续使用该会话或重发凭据；请按平台安全流程处置。\n');
    // 用 exitCode 而不是 process.exit，保证 stdout 先刷出去。
    process.exitCode = 2;
    return;
  }

  // 网页仅传公开服务地址；由插件直接保存，不让模型找插件目录或运行配置脚本。
  const connectPrefix = prompt.startsWith('Promate 平台地址：') ? 'Promate 平台地址：' : '/promate connect ';
  if (prompt.startsWith(connectPrefix)) {
    process.exitCode = 2;
    const address = prompt.slice(connectPrefix.length).trim();
    try {
      if (!/^https?:\/\/[^\s]+$/i.test(address)) throw new Error('地址格式错误');
      writeConfigUrl(address);
      process.stdout.write(`Promate 平台地址已保存：${resolveUrl(readConfig(true))}。旧 Key 已保留，换来源时不会发送；尚未验证身份。\n`);
    } catch {
      process.stdout.write('Promate 平台地址未保存；请核对网页公开地址并重试，勿发送 Key。\n');
    }
    return;
  }

  const routed = EXPLICIT_PATTERN.test(prompt) || CATEGORIES.some((category) => category.pattern.test(prompt));
  let confirmed = false;
  // 所有读改写都持同一会话锁，避免并发 hook 把已消费的确认写回。
  if (sessionId) withSessionState(sessionId, (state) => {
    const head = readUserMessageHead(sessionId);
    if (head.current !== messageId) throw new Error('本条消息已被更新的用户消息替代');
    const pending = state.pendingConfirm;
    // 只能接续紧邻的有效请求代次；取消后直接再说「确认」不能复活旧快照。
    if (pending && pending.messageId === head.previous && !isPendingExpired(pending) && isConfirmWord(prompt)) {
      writeState(sessionId, { ...state, pendingConfirm: { ...pending, messageId, confirmed: true, confirmedAt: Date.now() }, at: Date.now() });
      confirmed = true;
      return;
    }
    delete state.pendingConfirm;
    delete state.approvedCall;
    writeState(sessionId, { ...state, promateTurn: routed, promateCalled: false, at: Date.now() });
  });
  if (confirmed || !routed) return;

  const output = {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: buildContext(prompt, readConfig()),
    },
  };
  process.stdout.write(JSON.stringify(output) + '\n');
}

try {
  main();
} catch (error) {
  process.exitCode = 2;
  log('route 确认状态处理未完成，本条消息未建立写操作授权');
  process.stdout.write(messageRecorded && error.code === 'EEXIST'
    ? 'Promate 会话忙：旧的未消费确认已失效，本条消息未建立新授权；请稍后重新发起操作并确认。已获放行或提交的写入不能据此撤回。\n'
    : 'Promate 确认状态异常：未能安全完成本条消息处理，请停止写操作并检查本地会话状态；不能据此断言取消成功或已撤回业务写入。\n');
}
