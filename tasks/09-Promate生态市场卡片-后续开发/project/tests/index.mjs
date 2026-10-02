// `node --test plugins/tests/` 的目录入口。
//
// 当前 Node 22 会把「目录」参数直接交给子进程执行（而不是展开目录里的用例），
// 加上这份 package.json + index.mjs 后，目录参数会走到这里，把同目录所有用例
// 载入同一个测试子进程。用 `node --test plugins/tests/*.test.mjs` 时不会带上
// 本文件（不匹配 *.test.mjs），每个文件各自一个子进程，结果一样。

import './hooks-confirm.test.mjs';
import './hooks-guard.test.mjs';
import './hooks-route.test.mjs';
import './hooks-version.test.mjs';
import './proxy.test.mjs';
import './install-safety.test.mjs';
import './local-config.test.mjs';
import './desktop-preflight.test.mjs';
import './native-install.test.mjs';
import './first-connect.test.mjs';
import './resource-packages.test.mjs';
import './resources.test.mjs';
