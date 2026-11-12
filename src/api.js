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
  if (item.applied && item.applied.ok === false) {
    // 旧版本可能把系统原文（甚至乱码）存进 applied.error，这里统一换成能照着做的提示
    const err = String(item.applied.error || '');
    drift = /权限不足|管理员/.test(err)
      ? err
      : '上次同步失败，需要重新同步（如仍失败，请以管理员身份重新启动本程序）';
  } else if (!taskInfo) drift = '任务不存在，自启不会生效';
  else if (item.enabled && !taskInfo.enabled) drift = '任务被禁用（可能是外部修改）';
  else if (!item.enabled && taskInfo.enabled) drift = '任务仍处于启用状态';
  else if (item.applied && item.applied.templateVersion !== wrapper.TEMPLATE_VERSION)
    drift = `脚本模板已更新（v${item.applied.templateVersion || '?'} → v${wrapper.TEMPLATE_VERSION}），需要重新同步`;
  else if (item.applied && item.applied.runner && item.applied.runner !== sched.runnerCommand().exe)
    drift = '程序位置已变化，需要重新同步';

  // 目标文件被删掉时，计划任务本身不会消失，登录后仍会触发一个必然失败的任务
  let missing = null;
  if (item.kind === 'exe' && item.exePath && !fs.existsSync(item.exePath)) {
    missing = '目标文件不存在：' + item.exePath;
  }

  return { ...item, task: taskInfo, lastRun, drift, missing };
}

/**
 * 列表排序：按登录延迟从早到晚（相同延迟按创建时间、再按名称），
 * 让用户一眼看出谁先启动，而不是按创建顺序随机排。
 */
function compareByDelay(a, b) {
  const da = Number(a.trigger && a.trigger.delaySeconds) || 0;
  const db = Number(b.trigger && b.trigger.delaySeconds) || 0;
  if (da !== db) return da - db;
  const ca = String(a.createdAt || '');
  const cb = String(b.createdAt || '');
  if (ca !== cb) return ca < cb ? -1 : 1;
  return String(a.name || '').localeCompare(String(b.name || ''), 'zh');
}

function listView() {
  const tasks = sched.listTasks().tasks;
  const items = config
    .list()
    .map((it) => view(it, tasks.find((t) => t.name === it.id) || null))
    .sort(compareByDelay);
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
 * 启动时的自愈：只处理"确定性过期"的项（脚本模板版本变化、程序路径变化、上次注册失败），
 * 不去动被用户手工禁用的任务 —— 那属于人的意图，应该在界面上提示而不是偷偷改。
 * 一旦发现权限不足就立刻停止：后续项目也一定失败，继续尝试只会刷屏并拖慢启动。
 */
function resyncStale() {
  const currentRunner = sched.runnerCommand().exe;
  const elevated = sched.isElevated();
  const stale = config.list().filter((it) => {
    const a = it.applied;
    if (!a) return true;
    // 上次写入失败：只有提权后才自动重试，否则非管理员每次启动都会撞同一条“拒绝访问”
    if (a.ok === false) return elevated;
    if (a.templateVersion !== wrapper.TEMPLATE_VERSION) return true;
    if (a.runner && a.runner !== currentRunner) return true;
    return false;
  });
  if (!stale.length) return { count: 0, denied: false, total: 0 };

  // 脚本是纯本地产物：先全部重写（后面即使任务写入被拒绝，脚本也是最新的）
  for (const it of stale) wrapper.writeWrapper(it);

  // 只是脚本模板变了：任务动作没变，换掉 run.ps1/run.cmd 就够了，不必重新注册任务。
  // 否则普通权限启动时会把「管理员创建的任务」全部撞一遍拒绝访问 —— 这正是之前的刷屏来源。
  let tasks = null;
  const needTask = [];
  let count = 0;
  for (const it of stale) {
    const a = it.applied;
    const runnerChanged = !a || !a.runner || a.runner !== currentRunner;
    const scriptOnly = !!a && a.ok !== false && !runnerChanged && a.templateVersion !== wrapper.TEMPLATE_VERSION;
    if (scriptOnly) {
      if (tasks === null) {
        const listed = sched.listTasks();
        tasks = listed.ok ? listed.tasks : null;
      }
      // 任务还在 → 只更新脚本和 applied 记录；任务丢了才需要重建
      if (tasks && tasks.some((t) => t.name === it.id)) {
        config.markApplied(it.id, {
          ...a,
          at: new Date().toISOString(),
          ok: true,
          error: null,
          templateVersion: wrapper.TEMPLATE_VERSION,
        });
        count += 1;
        continue;
      }
    }
    needTask.push(it);
  }

  let denied = false;
  for (const it of needTask) {
    const res = applyTask(it);
    if (res.ok) {
      count += 1;
      continue;
    }
    if (res.denied) {
      // 没有权限时后面的项目必然同样失败，停止尝试，只在界面上提示一次
      denied = true;
      break;
    }
  }
  return { count, denied, total: stale.length };
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
    denied: !!res.denied,
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
    denied: !!res.denied,
  });
}

function deleteItem(id) {
  const item = config.get(id);
  if (!item) return bad(404, '项目不存在');
  // 任务没删掉就删配置，会留下一个谁都管不了的孤儿任务 —— 先删任务，失败就别动配置
  const removedTask = sched.removeItem(id);
  if (!removedTask.ok) {
    return bad(removedTask.denied ? 403 : 500, (removedTask.error || '移除计划任务失败') + '（项目未删除）');
  }
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
    const previous = item.enabled;
    item.enabled = on;
    item.updatedAt = new Date().toISOString();
    config.upsert(item);
    let res = sched.setEnabled(id, on);
    if (!res.ok && !res.denied) res = applyTask(item); // 任务被外部删除时自愈
    if (!res.ok) {
      // 任务没改成，配置也回滚，避免界面显示“已停用”但登录时照样启动
      item.enabled = previous;
      config.upsert(item);
      return ok({
        item: view(config.get(id), taskOf(id)),
        taskError: res.error || '更新计划任务失败',
        denied: !!res.denied,
      });
    }
    const info = {
      state: res.state || (on ? 'Ready' : 'Disabled'),
      enabled: on,
      lastResult: null,
      nextRun: null,
    };
    return ok({ item: view(config.get(id), info) });
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
    if (r.denied) {
      // 权限不足时一个任务都注销不了：别把数据删掉，否则会留下无法管理的孤儿任务
      return bad(403, sched.PERMISSION_HINT + '（卸载已取消，未删除任何数据）');
    }
    if (!r.ok) {
      return bad(500, `无法注销计划任务 ${name}：${r.error || '未知错误'}（卸载已取消，未删除任何数据）`);
    }
    removed.push(name);
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
  let denied = false;
  for (const item of config.list()) {
    wrapper.writeWrapper(item);
    const res = applyTask(item);
    results.push({ id: item.id, ok: !!res.ok, error: res.error || null });
    if (res.denied) {
      // 没有权限时后面的项目必然同样失败，停止尝试，只在界面上提示一次
      denied = true;
      break;
    }
  }
  return ok({ results, denied });
}

/** 目标文件已不存在的项目（会残留一个每次登录都失败的任务） */
function isMissingTarget(item) {
  return item.kind === 'exe' && !!item.exePath && !fs.existsSync(item.exePath);
}

/** 一键清理失效项：反注册任务 + 删配置 + 删脚本目录 */
function cleanupMissing() {
  const removed = [];
  for (const item of [...config.list()]) {
    if (!isMissingTarget(item)) continue;
    const r = sched.removeItem(item.id);
    if (r.denied) {
      return ok({ removed, denied: true, error: sched.PERMISSION_HINT });
    }
    if (!r.ok) {
      log.warn('清理失效项失败，已跳过', item.id, r.error || '');
      continue;
    }
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