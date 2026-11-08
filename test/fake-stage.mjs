#!/usr/bin/env node
/** 旧流水线替身停用；新卡场景使用 fake-kernel-pi.mjs，不再制造旧 done/inbox。 */
console.error("旧段替身已停用；请迁移到 version:1 开发卡及 kernel/host fixture");
process.exitCode = 2;
