'use strict';
/**
 * HTTP API。所有写操作都走 POST/PUT/DELETE（要求自定义头，天然抗 CSRF），
 * 所有返回都是 JSON；脚本预览返回"实际会被执行的内容"。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const config = require('./config');
const wrapper = require('./wrapper');
const sched = require('./sched');
const runner = require('./runner');
const log = require('./log');
const { SEA, ROOT, itemDir } = require('./paths');

let probeCache = { at: 0, value: null };

function probeCached() {
  const now = Date.now();
  if (probeCache.value && now - probeCache.at < 30000) return probeCache.value;
  const value = sched.probe();
  probeCache = { at: now, value };
  return value;
}

function ok(json) {
  return { status: 200, json };
}
function bad(status, message, extra) {
  return { status, json: { error: message, ...(extra || {}) } };
}

function taskOf(id, allTasks) {
  const tasks = allTasks || sched.listTasks().tasks;
  return tasks.find((t) => t.name === id) || null;
}

function view(item, task) {
  const lastRun = runner.readLastRun(item.id) || item.lastRun || null;
  const taskInfo = task
    ? {
        state: task.state || null,
        enabled: !!task.enabled,
        lastResult: task.lastResult === undefined ? null : task.lastResult,
        nextRun: task.nextRun || null,
      }
    : null;
  let drift = null;
  if (!taskInfo) drift = '任务不存在，自启不会生效';
  else if (item.enabled && !taskInfo.enabled) drift = '任务被禁用（可能是外部修改）';
  else if (!item.enabled && taskInfo.enabled) drift = '任务仍处于启用状态';
  else if (item.applied && item.applied.templateVersion !== wrapper.TEMPLATE_VERSION)
    drift = `脚本模板已更新（v${item.applied.templateVersion || '?'} → v${wrapper.TEMPLATE_VERSION}），需要重新同步`;
  else if (item.applied && item.applied.runner && item.applied.runner !== sched.runnerCommand().exe)
    drift = '程序位置已变化，需要重新同步';

  // 目标文件被删掉时，计划任务本身不会消失，登录后仍会触发一个必然失败的任务
  let missing = null;
  if (item.kind === 'exe' && item.exePath && !fs.existsSync(item.exePath)) {
    missing = '可执行文件不存在：' + item.exePath;
  }

  return { ...item, task: taskInfo, lastRun, drift, missing };
}

function listView() {
  const tasks = sched.listTasks().tasks;
  const items = config.list().map((it) => view(it, tasks.find((t) => t.name === it.id) || null));
  return { items, fake: sched.isFake() };
}

function applyTask(item) {
  const res = sched.applyItem(item);
  config.markApplied(item.id, {
    at: new Date().toISOString(),
    ok: !!res.ok,
    error: res.error || null,
    runner: sched.runnerCommand().exe,
    templateVersion: wrapper.TEMPLATE_VERSION,
    fake: !!res.fake,
  });
  return res;
}

/**
 * 启动时的自愈：只处理"确定性过期"的项（脚本模板版本变化、程序路径变化），
 * 不去动被用户手工禁用的任务 —— 那属于人的意图，应该在界面上提示而不是偷偷改。
 */
function resyncStale() {
  const stale = config.list().filter((it) => {
    const a = it.applied;
    if (!a) return true;
    if (a.templateVersion !== wrapper.TEMPLATE_VERSION) return true;
    if (a.runner && a.runner !== sched.runnerCommand().exe) return true;
    return false;
  });
  for (const it of stale) {
    wrapper.writeWrapper(it);
    applyTask(it);
  }
  return stale.length;
}

function systemInfo() {
  const probe = probeCached();
  const osInfo = os;
  return {
    app: {
      version: require('../package.json').version,
      node: process.version,
      sea: SEA,
      dataDir: ROOT,
      runner: sched.runnerCommand().exe,
      fakeScheduler: sched.isFake(),
    },
    os: {
      name: `${osInfo.type()} ${osInfo.release()}`,
      arch: osInfo.arch(),
      hostname: osInfo.hostname(),
    },
    user: sched.currentUser(),
    isAdmin: !!probe.admin,
    scheduler: { ok: !!probe.ok, error: probe.error || null, fake: !!probe.fake },
    taskPath: sched.TASK_PATH,
  };
}

/** 写操作的返回里自带上任务状态，避免再查一次（旧实现每次保存多花 2.6 秒） */
function taskInfoFromApply(item, res) {
  if (!res || !res.ok) return null;
  const state = res.state || (item.enabled === false ? 'Disabled' : 'Ready');
  return {
    state,
    enabled: item.enabled !== false && state !== 'Disabled',
    lastResult: null,
    nextRun: null,
  };
}

function createItem(body) {
  const item = config.normalizeItem(body, null);
  item.enabled = body.enabled !== false;
  const v = config.validate(item);
  if (v.errors.length) return bad(400, '参数校验未通过', { errors: v.errors, warnings: v.warnings });
  wrapper.writeWrapper(item);
  config.upsert(item);
  const res = applyTask(item);
  return ok({
    item: view(config.get(item.id), taskInfoFromApply(item, res)),
    warnings: v.warnings,
    taskError: res.ok ? null : res.error,
  });
}

function updateItem(id, body) {
  const existing = config.get(id);
  if (!existing) return bad(404, '项目不存在');
  const item = config.normalizeItem({ ...body, id }, existing);
  const v = config.validate(item);
  if (v.errors.length) return bad(400, '参数校验未通过', { errors: v.errors, warnings: v.warnings });
  wrapper.writeWrapper(item);
  config.upsert(item);
  const res = applyTask(item);
  return ok({
    item: view(config.get(id), taskInfoFromApply(item, res)),
    warnings: v.warnings,
    taskError: res.ok ? null : res.error,
  });
}

function deleteItem(id) {
  const item = config.get(id);
  if (!item) return bad(404, '项目不存在');
  sched.removeItem(id);
  config.remove(id);
  try {
    fs.rmSync(itemDir(id), { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
  return ok({ deleted: id });
}

/**
 * 「直接运行」：用 cmd 的 start 拉起，Windows 会给目标新建一个控制台并把标准句柄指向它。
 * 不要用 detached + stdio:'ignore' 直接 spawn —— 那会把 stdout 换成 NUL，窗口全黑。
 */
function spawnRunnerDetached(item) {
  const cmd = sched.runnerCommand();
  const cli = [cmd.exe, ...cmd.args, '--run', item.id].map(sched.quoteWin).join(' ');
  const child = spawn('cmd.exe', ['/d', '/s', '/c', `start "" ${cli}`], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    cwd: ROOT,
    windowsVerbatimArguments: true,
  });
  child.unref();
  return child.pid;
}

function itemAction(id, action) {
  const item = config.get(id);
  if (!item) return bad(404, '项目不存在');

  if (action === 'enable' || action === 'disable') {
    const on = action === 'enable';
    item.enabled = on;
    item.updatedAt = new Date().toISOString();
    config.upsert(item);
    let res = sched.setEnabled(id, on);
    if (!res.ok) res = applyTask(item); // 任务被外部删除时自愈
    const info = res.ok
      ? { state: res.state || (on ? 'Ready' : 'Disabled'), enabled: on, lastResult: null, nextRun: null }
      : null;
    return ok({ item: view(config.get(id), info), taskError: res.ok ? null : res.error });
  }

  if (action === 'run') {
    const pid = spawnRunnerDetached(item);
    return ok({ started: true, pid });
  }

  if (action === 'resync') {
    wrapper.writeWrapper(item);
    const res = applyTask(item);
    return ok({ item: view(config.get(id), taskInfoFromApply(item, res)), taskError: res.ok ? null : res.error });
  }

  if (action === 'duplicate') {
    const copy = config.normalizeItem({ ...item, id: undefined, name: item.name + ' 副本', enabled: false }, null);
    wrapper.writeWrapper(copy);
    config.upsert(copy);
    const res = applyTask(copy);
    return ok({ item: view(config.get(copy.id), taskInfoFromApply(copy, res)) });
  }

  return bad(404, '未知操作');
}

function scriptPreviewFor(item) {
  let content;
  try {
    const file = path.join(itemDir(item.id), item.kind === 'exe' ? 'run.cmd' : 'run.ps1');
    content = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    const p = wrapper.preview(item);
    content = p.content;
  }
  return content;
}

function openDataDir() {
  try {
    spawn('explorer.exe', [ROOT], { detached: true, stdio: 'ignore' }).unref();
    return ok({ opened: ROOT });
  } catch (e) {
    return bad(500, e.message);
  }
}


/**
 * 卸载：注销全部计划任务 + 删除数据目录，然后进程退出。
 * 退出后用户直接删除 exe 即可，不留残留（任务、配置、脚本、日志、token 全清）。
 */
function uninstallTool(body) {
  if (!body || body.confirm !== 'UNINSTALL') return bad(400, '确认口令不正确');

  const names = new Set(sched.listTasks().tasks.map((t) => t.name));
  for (const item of config.list()) names.add(item.id);

  const removed = [];
  for (const name of names) {
    const r = sched.removeItem(name);
    if (r.ok) removed.push(name);
  }

  let deleted = false;
  let error = null;
  for (let i = 0; i < 5; i += 1) {
    try {
      fs.rmSync(ROOT, { recursive: true, force: true });
      deleted = true;
      break;
    } catch (e) {
      error = e.message;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150 * (i + 1));
    }
  }

  // 这里不能写文件日志（数据目录刚被删掉，会把它重建出来）
  console.log(
    `[StartupManager] 已卸载：注销任务 ${removed.length} 个，数据目录${deleted ? '已删除' : '删除失败：' + error}`
  );

  // 先把响应发出去，再退出进程
  setTimeout(() => process.exit(0), 800);
  return ok({ removedTasks: removed.length, dataDir: ROOT, deleted, error });
}

function reconcileAll() {
  const results = [];
  for (const item of config.list()) {
    wrapper.writeWrapper(item);
    const res = applyTask(item);
    results.push({ id: item.id, ok: !!res.ok, error: res.error || null });
  }
  return ok({ results });
}

/** 目标 exe 已不存在的项目（会残留一个每次登录都失败的任务） */
function isMissingTarget(item) {
  return item.kind === 'exe' && !!item.exePath && !fs.existsSync(item.exePath);
}

/** 一键清理失效项：反注册任务 + 删配置 + 删脚本目录 */
function cleanupMissing() {
  const removed = [];
  for (const item of [...config.list()]) {
    if (!isMissingTarget(item)) continue;
    sched.removeItem(item.id);
    config.remove(item.id);
    try {
      fs.rmSync(itemDir(item.id), { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
    removed.push({ id: item.id, name: item.name });
    log.info('已清理失效项', item.id, item.name);
  }
  return ok({ removed });
}

function dispatch(method, pathname, body) {
  const p = pathname.replace(/\/+$/, '') || '/';
  const seg = p.split('/').filter(Boolean);
  if (seg[0] !== 'api') return null;
  const M = String(method || 'GET').toUpperCase();
  const resource = seg[1];
  const id = seg[2];
  const action = seg[3];

  if (resource === 'system' && !id) {
    if (M !== 'GET') return bad(405, '方法不允许');
    return ok(systemInfo());
  }

  if (resource === 'uninstall') {
    if (M !== 'POST') return bad(405, '方法不允许');
    return uninstallTool(body || {});
  }

  if (resource === 'items') {
    if (!id) {
      if (M === 'GET') return ok(listView());
      if (M === 'POST') return createItem(body || {});
      return bad(405, '方法不允许');
    }
    if (!action) {
      if (M === 'GET') {
        const it = config.get(id);
        if (!it) return bad(404, '项目不存在');
        return ok(view(it, taskOf(id)));
      }
      if (M === 'PUT' || M === 'PATCH') return updateItem(id, body || {});
      if (M === 'DELETE') return deleteItem(id);
      return bad(405, '方法不允许');
    }
    if (action === 'script' && M === 'GET') {
      const it = config.get(id);
      if (!it) return bad(404, '项目不存在');
      return ok({ content: scriptPreviewFor(it) });
    }
    if (M === 'POST') return itemAction(id, action);
    return bad(405, '方法不允许');
  }

  if (resource === 'preview' && M === 'POST') {
    const draft = config.normalizeItem(body || {}, null);
    const v = config.validate(draft);
    return ok({ ...wrapper.preview(draft), errors: v.errors, warnings: v.warnings });
  }

  if (resource === 'tasks' && id === 'resync' && M === 'POST') return reconcileAll();
  if (resource === 'tasks' && id === 'cleanup-missing' && M === 'POST') return cleanupMissing();

  if (resource === 'open' && id === 'data' && M === 'POST') return openDataDir();

  return bad(404, '接口不存在');
}

module.exports = { dispatch, reconcileAll, resyncStale, cleanupMissing, listView };