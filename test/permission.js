'use strict';
/**
 * 权限不足时的行为测试（不需要管理员，也不会碰真实计划任务）：
 * 把 sched 的写操作替换成「拒绝访问」，验证 API 会
 *   - 返回统一友好提示（而不是系统原文/乱码）
 *   - 批量同步遇到第一个拒绝就停下，不逐项重试
 *   - 删除/清理/卸载失败时不删配置（避免留下孤儿任务）
 *   - 启停失败时回滚配置
 *
 * 用法：node test/permission.js
 */
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', '.sm-perm-test');
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
process.env.SM_DATA_DIR = DATA;
process.env.SM_FAKE_TASKS = '1'; // 双保险：即使有漏网的调用也不会碰真实调度器

const config = require('../src/config');
const sched = require('../src/sched');
const api = require('../src/api');
const wrapper = require('../src/wrapper');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log('  ✓ ' + name);
  } else {
    fail += 1;
    console.log('  ✗ ' + name + (extra === undefined ? '' : '  → ' + JSON.stringify(extra)));
  }
}

function seed(input) {
  return config.upsert(config.normalizeItem(input, null));
}

console.log('\n[1] 只是脚本模板升级：只重写脚本，不重新注册任务');
sched.isElevated = () => false; // 固定成普通权限，保证测试结果与机器是否提权无关
const itemC = seed({
  name: '仅模板升级',
  kind: 'exe',
  exePath: 'C:\\Windows\\System32\\cmd.exe',
  trigger: { delaySeconds: 0 },
  enabled: true,
});
config.markApplied(itemC.id, {
  at: new Date().toISOString(),
  ok: true,
  error: null,
  runner: sched.runnerCommand().exe,
  templateVersion: wrapper.TEMPLATE_VERSION - 1,
  fake: false,
});
// 上次写入失败的项：普通权限下不应在启动时自动重试（避免每次开机都刷同一条错误）
const itemD = seed({
  name: '上次失败项',
  kind: 'exe',
  exePath: 'C:\\Windows\\System32\\notepad.exe',
  trigger: { delaySeconds: 0 },
  enabled: true,
});
config.markApplied(itemD.id, {
  at: new Date().toISOString(),
  ok: false,
  error: '拒绝访问。',
  runner: sched.runnerCommand().exe,
  templateVersion: wrapper.TEMPLATE_VERSION,
  fake: false,
});
let listCalls = 0;
sched.listTasks = () => {
  listCalls += 1;
  return { ok: true, tasks: [{ name: itemC.id, state: 'Ready', enabled: true }] };
};
sched.applyItem = () => {
  throw new Error('模板升级不应重新注册计划任务');
};
const scriptOnly = api.resyncStale();
check('识别为待同步但已完成脚本刷新', scriptOnly.denied === false && scriptOnly.count === 1 && scriptOnly.total === 1, scriptOnly);
check('没有调用 applyItem（没有碰计划任务）', true);
check('applied 模板版本已更新', config.get(itemC.id).applied.templateVersion === wrapper.TEMPLATE_VERSION, config.get(itemC.id).applied);
check('脚本已重写', fs.existsSync(path.join(DATA, 'items', itemC.id, 'run.cmd')));
check('只查了一次任务列表', listCalls === 1, listCalls);
check('上次失败项没有在普通权限下被自动重试', config.get(itemD.id).applied.error === '拒绝访问。', config.get(itemD.id).applied);

const itemA = seed({
  name: '权限测试 A',
  kind: 'exe',
  exePath: 'C:\\Windows\\System32\\cmd.exe',
  trigger: { delaySeconds: 0 },
  enabled: true,
});
const itemB = seed({
  name: '权限测试 B',
  kind: 'powershell',
  command: 'Write-Output hi',
  trigger: { delaySeconds: 0 },
  enabled: true,
});

// 让所有写操作都表现为「拒绝访问」
let applyCalls = 0;
sched.applyItem = () => {
  applyCalls += 1;
  return { ok: false, denied: true, error: sched.PERMISSION_HINT };
};
let removeCalls = 0;
sched.removeItem = () => {
  removeCalls += 1;
  return { ok: false, denied: true, error: sched.PERMISSION_HINT };
};
let enableCalls = 0;
sched.setEnabled = () => {
  enableCalls += 1;
  return { ok: false, denied: true, error: sched.PERMISSION_HINT };
};

console.log('\n[2] 启动自动同步：第一个被拒绝就停');
const res = api.resyncStale();
check('返回 denied 标记', res.denied === true, res);
check('只尝试一次（不逐项重试）', applyCalls === 1, applyCalls);
check('两个项目都算待同步', res.total === 2 && res.count === 0, res);
check(
  '两个项目的脚本都被重写（脚本先于任务写入）',
  fs.existsSync(path.join(DATA, 'items', itemA.id, 'run.cmd')) && fs.existsSync(path.join(DATA, 'items', itemB.id, 'run.ps1'))
);
check('第二个项目没有被写入 applied', config.get(itemB.id).applied === null, config.get(itemB.id).applied);

console.log('\n[3] 手动重新同步：同样只尝试一次');
applyCalls = 0;
const all = api.reconcileAll();
check('reconcileAll 带 denied', all.json.denied === true, all.json);
check('只尝试一次', applyCalls === 1, applyCalls);
check('结果里只有第一条失败', all.json.results.length === 1 && all.json.results[0].ok === false, all.json.results);

console.log('\n[4] 删除失败不删配置');
const del = api.dispatch('DELETE', `/api/items/${itemA.id}`, {});
check('删除返回 403', del.status === 403, del.status);
check('提示包含管理员指引', String(del.json.error).includes('管理员'), del.json.error);
check('配置还在', !!config.get(itemA.id));

console.log('\n[5] 启停失败要回滚配置');
const before = config.get(itemA.id).enabled;
const off = api.dispatch('POST', `/api/items/${itemA.id}/disable`, {});
check('启用状态被回滚', off.json.item.enabled === before && config.get(itemA.id).enabled === before, off.json);
check('响应带 denied 和友好提示', off.json.denied === true && String(off.json.taskError).includes('管理员'), off.json);
check('只尝试一次启停', enableCalls === 1, enableCalls);

console.log('\n[6] 清理失效项失败时保留配置');
const missing = seed({
  name: '失效项',
  kind: 'exe',
  exePath: 'C:\\Windows\\__definitely_missing__\\nope.exe',
  trigger: { delaySeconds: 0 },
  enabled: true,
});
removeCalls = 0;
const cleanup = api.cleanupMissing();
check('返回 denied', cleanup.json.denied === true, cleanup.json);
check('没有删除任何配置', cleanup.json.removed.length === 0 && !!config.get(missing.id), cleanup.json);
check('只尝试一次删除', removeCalls === 1, removeCalls);

fs.rmSync(DATA, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
