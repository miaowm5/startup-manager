'use strict';
/**
 * 入口：
 *   startup-manager              启动配置服务并打开浏览器
 *   startup-manager --run <id>   以控制台宿主身份运行某个项目（计划任务调用）
 *   startup-manager --resync     重新同步全部计划任务
 *   startup-manager --clean-missing 清理失效项
 *
 * 测试/自动化可用环境变量 SM_NO_OPEN=1 阻止自动打开浏览器。
 */

// 必须在加载 paths 之前解析 --data-dir（便携模式：计划任务里也会带上这个参数）
(function preScanDataDir() {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--data-dir' && argv[i + 1]) process.env.SM_DATA_DIR = argv[i + 1];
  }
})();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const config = require('./config');
const sched = require('./sched');
const runner = require('./runner');
const server = require('./server');
const api = require('./api');
const log = require('./log');
const { writeFileRetry } = require('./fsutil');
const { ensureDirs, files, ROOT, SEA } = require('./paths');

const pkg = require('../package.json');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--run') out.run = argv[++i];
    else if (a === '--run-now') out.runNow = argv[++i];
    else if (a === '--data-dir') out.dataDir = argv[++i];
    else if (a === '--dev') out.dev = true;
    else if (a === '--resync') out.resync = true;
    else if (a === '--clean-missing') out.cleanMissing = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--version' || a === '-v') out.version = true;
    else out._.push(a);
  }
  return out;
}

function printHelp() {
  console.log(`StartupManager ${pkg.version}

用法：
  startup-manager                启动配置界面（默认）
  startup-manager --run <id>     运行指定项目（计划任务调用，勿手工使用）
  startup-manager --run-now <id> 直接运行指定项目并在当前控制台看输出（人工测试用）
  startup-manager --resync       重新生成脚本并同步全部计划任务
  startup-manager --clean-missing 清理目标已不存在的失效项（任务 + 配置）
  startup-manager --data-dir <d> 使用指定数据目录（便携模式；注册任务时会自动带上）

数据目录：%LOCALAPPDATA%\\StartupManager（可用 SM_DATA_DIR 覆盖）`);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readServerInfo() {
  try {
    return JSON.parse(fs.readFileSync(files.server, 'utf8'));
  } catch {
    return null;
  }
}

function acquireLock() {
  ensureDirs();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(files.lock, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return { acquired: true };
    } catch (e) {
      if (e.code !== 'EEXIST') return { acquired: true, warning: e.message };
      let pid = 0;
      try {
        pid = Number.parseInt(fs.readFileSync(files.lock, 'utf8').trim(), 10);
      } catch {
        pid = 0;
      }
      if (pid && isAlive(pid)) {
        const info = readServerInfo();
        return { acquired: false, url: info ? info.url : null, pid };
      }
      try {
        fs.unlinkSync(files.lock);
      } catch {
        /* 忽略 */
      }
    }
  }
  return { acquired: true };
}

function releaseLock() {
  try {
    fs.unlinkSync(files.lock);
  } catch {
    /* 忽略 */
  }
  try {
    const info = readServerInfo();
    if (info && info.pid === process.pid) fs.unlinkSync(files.server);
  } catch {
    /* 忽略 */
  }
}

/** 监听端口：默认 8767，可用环境变量 SM_PORT 覆盖（仅供调试/测试）；被占用时自动换随机端口 */
function preferredPort() {
  const n = Number.parseInt(process.env.SM_PORT || '', 10);
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : 8767;
}

function listenOn(srv, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      if (port !== 0 && (err.code === 'EADDRINUSE' || err.code === 'EACCES')) {
        srv.removeListener('error', onError);
        srv.listen(0, '127.0.0.1', () => resolve(srv.address().port));
      } else {
        reject(err);
      }
    };
    srv.on('error', onError);
    srv.listen(port, '127.0.0.1', () => resolve(srv.address().port));
  });
}

/** 测试/自动化时用 SM_NO_OPEN=1 抑制自动打开浏览器 */
function noOpen() {
  return process.env.SM_NO_OPEN === '1';
}

function openBrowser(url) {
  try {
    spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {
    /* 忽略 */
  }
}

async function serve(args) {
  ensureDirs();

  // 自动修复"确定性过期"的项目（脚本模板升级、程序被移动、上次注册失败），无需用户手动点同步。
  // 遇到权限不足会立刻停下（而不是每个项目都刷一条“拒绝访问”），并给出一次可操作的提示。
  try {
    const r = api.resyncStale();
    if (r.denied) {
      console.log('[StartupManager] 自动同步中断：' + sched.PERMISSION_HINT);
      const rest = r.total - r.count;
      if (rest > 0) console.log(`[StartupManager] 已跳过其余 ${rest} 个待同步项目，脚本已更新但计划任务未全部同步。`);
    } else if (r.count) {
      console.log(`[StartupManager] 已自动重新同步 ${r.count} 个过期项目（模板或程序路径变化）`);
    }
  } catch (e) {
    log.warn('自动同步失败', e.message);
  }
  if (sched.isFake()) {
    // 测试模式：让 fake 调度器里有与配置一致的任务记录
    api.reconcileAll();
  }

  const lock = acquireLock();
  if (!lock.acquired) {
    const url = lock.url || 'http://127.0.0.1:8767/';
    console.log('StartupManager 已在运行：' + url);
    if (!noOpen()) openBrowser(url);
    return;
  }

  const token = process.env.SM_TOKEN || crypto.randomBytes(24).toString('hex');
  const ctx = { token, port: 0 };
  const srv = server.createServer(ctx);

  let port;
  let url;
  try {
    port = await listenOn(srv, preferredPort());
    ctx.port = port;
    url = `http://127.0.0.1:${port}/?t=${token}`;
    writeFileRetry(
      files.server,
      JSON.stringify({ port, token, pid: process.pid, url, startedAt: new Date().toISOString() }, null, 2)
    );
  } catch (err) {
    try {
      srv.close();
    } catch {
      /* 忽略 */
    }
    releaseLock();
    throw err;
  }

  console.log('');
  console.log('────────────────────────────────────────────────────────────');
  console.log(`  StartupManager ${pkg.version}  已启动`);
  console.log(`  配置界面：${url}`);
  console.log(`  数据目录：${ROOT}`);
  console.log(`  运行形态：${SEA ? '单文件 exe' : 'Node.js（开发态）'}`);
  console.log('  提示：关闭本窗口即停止服务，已注册的自启项不受影响');
  console.log('────────────────────────────────────────────────────────────');
  console.log('');

  log.info('服务已启动', url);

  if (!noOpen()) openBrowser(url);

  const shutdown = (signal) => {
    log.info('收到退出信号', signal);
    srv.close(() => {
      releaseLock();
      process.exit(0);
    });
    setTimeout(() => {
      releaseLock();
      process.exit(0);
    }, 1500).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printHelp();
  if (args.version) return console.log(pkg.version);

  // 未知参数直接拒绝：避免把 `--stop` 这类已移除的参数当成"正常启动"
  const unknown = args._.filter((a) => String(a).startsWith('-'));
  if (unknown.length) {
    console.error('未知参数：' + unknown.join(' ') + '（可用参数见 --help）');
    console.error('提示：停止服务直接关闭控制台窗口即可。');
    process.exitCode = 2;
    return;
  }

  if (args.run) return runner.run(args.run);
  if (args.runNow) return runner.run(args.runNow, { keepOpen: false, noRelaunch: true });
  if (args.resync) {
    const res = api.reconcileAll();
    const results = (res.json && res.json.results) || [];
    if (res.json && res.json.denied) {
      const first = results.find((r) => !r.ok);
      console.error('同步失败：' + (first && first.error ? first.error : sched.PERMISSION_HINT));
      console.error('请以管理员身份重新运行本程序后再试。');
      process.exitCode = 1;
      return;
    }
    const failed = results.filter((r) => !r.ok);
    console.log(`已同步 ${results.length} 个项目，失败 ${failed.length} 个`);
    failed.forEach((f) => console.log('  - ' + f.id + '：' + f.error));
    return;
  }
  if (args.cleanMissing) {
    const res = api.cleanupMissing();
    if (res.json && res.json.denied) {
      console.error('清理失败：' + (res.json.error || sched.PERMISSION_HINT));
      console.error('请以管理员身份重新运行本程序后再试。');
      process.exitCode = 1;
      return;
    }
    const removed = res.json.removed;
    if (!removed.length) console.log('没有失效项需要清理。');
    else {
      console.log(`已清理 ${removed.length} 个失效项（任务与配置均已删除）：`);
      removed.forEach((r) => console.log('  - ' + r.name + '（' + r.id + '）'));
    }
    return;
  }
  serve(args).catch((err) => {
    log.error('启动失败', err && err.stack ? err.stack : String(err));
    console.error('启动失败：' + (err && err.message));
    process.exitCode = 1;
  });
}

main();
