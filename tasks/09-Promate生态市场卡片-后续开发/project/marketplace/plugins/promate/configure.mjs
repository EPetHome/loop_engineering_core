#!/usr/bin/env node
// 仅供研发在隔离环境检查内部原子保存；不是普通用户配置 Key 的路径。
import { configKey, readConfig, resolveUrl, writeConfigKey, writeConfigUrl } from './hooks/lib.mjs';

async function hiddenKey() {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) throw new Error('请在自己的交互终端运行 --key，不接受模型或管道输入');
  process.stdout.write('粘贴个人 Key 后回车（隐藏输入，Ctrl-C 取消）：');
  return new Promise((resolve, reject) => {
    let value = '';
    const restore = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off('data', onData);
      process.stdout.write('\n');
    };
    const onData = (chunk) => {
      for (const char of chunk.toString()) {
        if (char === '\u0003') { restore(); reject(new Error('已取消，未保存')); return; }
        if (char === '\r' || char === '\n') { restore(); resolve(value.trim()); return; }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (/^[A-Za-z0-9_]$/.test(char)) value += char;
        else { restore(); reject(new Error('Key 格式无效，未保存')); return; }
      }
    };
    process.stdin.setRawMode(true);
    process.stdin.on('data', onData);
    process.stdin.resume();
  });
}

try {
  const [mode, value, ...extra] = process.argv.slice(2);
  if (extra.length || !['--url', '--key', '--check'].includes(mode) || (mode !== '--url' && value)) {
    throw new Error('用法：node configure.mjs --url <公开平台地址> | --key | --check；禁止通过命令参数传 Key');
  }
  if (mode === '--url') {
    writeConfigUrl(value);
    process.stdout.write('平台地址已保存；已有 Key 和其它字段已保留，跨来源的旧 Key 不会发送。\n');
  } else if (mode === '--key') {
    const config = readConfig(true);
    if (!config.url) throw new Error('请先运行 --url 配置平台地址');
    // URL 已校验、不含凭据。用户在隐藏输入前确认绑定的来源。
    const targetUrl = resolveUrl(config);
    process.stdout.write(`目标服务：${targetUrl}\n`);
    const key = await hiddenKey();
    if (!/^pk_[A-Za-z0-9]{16,}$/.test(key)) throw new Error('Key 格式无效，未保存');
    writeConfigKey(key, targetUrl);
    process.stdout.write('Key 已保存，未执行网络请求。请在 WorkBuddy 查询本人项目验证连接。\n');
  } else {
    const config = readConfig(true);
    process.stdout.write(`地址：${config.url ? resolveUrl(config) : '未配置（仅本机开发有 localhost 回退）'}\n`);
    process.stdout.write(`Key：${configKey(config) ? '已保存（不显示）' : '未配置'}；本检查不验证平台连通。\n`);
  }
} catch (error) {
  // 只输出本程序固定错误；底层 I/O 错误可能包含用户路径，不输出原文。
  const safe = /^(请|已取消|Key 格式|用法|平台地址|配置|无法保护)/.test(error.message);
  process.stderr.write(`${safe ? error.message : '本地配置失败，请检查参数、配置格式和文件权限'}\n`);
  process.exitCode = 1;
}
