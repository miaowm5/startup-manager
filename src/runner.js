'use strict';
/**
 * 控制台宿主：由计划任务（或"立即运行"）拉起，负责
 *  - 拿到一个可见的控制台窗口（Node 本身是控制台子系统程序）
 *  - 运行生成的 wrapper 脚本，输出直连控制台
 *  - 结束后按 keepOpen 决定是否等用户按键再关闭
 *  - 把本次结果写到 items/<id>/last-run.json（另开文件，避免与服务端争写 config.json）
 *
 * 关键：不能依赖"继承来的 stdout"。
 *   `spawn(..., { stdio: 'ignore' })` 会把子进程的标准句柄指向 NUL，
 *   此时窗口虽然存在，但所有输出都进了空设备 —— 用户看到的就是一个全黑的窗口。
 *   所以这里显式打开 CONOUT$/CONIN$（当前控制台的字符设备），把它们交给子进程。
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { itemDir } = require('./paths');
const log = require('./log');

let con = { ok: false };

/** 打开当前控制台的输入输出设备；失败则退化为进程标准流 */
function attachConsole() {
  // 控制台代码页统一 UTF-8，和 wrapper 里的 [Console]::OutputEncoding 对齐
  try {
    spawnSync('cmd.exe', ['/d', '/c', 'chcp 65001'], { stdio: 'ignore', windowsHide: true, timeout: 5000 });
  } catch {
    /* 无控制台时会失败，忽略 */
  }
  try {
    con = { ok: true, out: fs.openSync('CONOUT$', 'w'), in: fs.openSync('CONIN$', 'r') };
  } catch {
    con = { ok: false };
  }
}

function write(text) {
  if (con.ok) {
    try {
      fs.writeSync(con.out, text);
      return;
    } catch {
      /* 落到标准流 */
    }
  }
  process.stdout.write(text);
}

function writeErr(text) {
  if (con.ok) {
    try {
      fs.writeSync(con.out, text);
      return;
    } catch {
      /* 落到标准流 */
    }
  }
  process.stderr.write(text);
}

function stdioForChild() {
  // 已挂在真控制台上：直接继承最可靠
  if (process.stdout.isTTY) return 'inherit';
  return con.ok ? [con.in, con.out, con.out] : 'inherit';
}

function winQuote(arg) {
  const s = String(arg);
  if (s === '') return '""';
  if (!/[ \t\n\v"]/.test(s)) return s;
  let out = '"';
  let bs = 0;
  for (const c of s) {
    if (c === '\\') {
      bs += 1;
      out += '\\';
    } else if (c === '"') {
      out += '\\'.repeat(bs) + '\\"';
      bs = 0;
    } else {
      out += c;
      bs = 0;
    }
  }
  out += '\\'.repeat(bs) + '"';
  return out;
}

/**
 * stdout 不是真控制台时（被 stdio:'ignore' 换成 NUL，或由任务计划程序无句柄启动），
 * 用 `start` 重新拉起自己：Windows 会给目标新建一个控制台，并把标准句柄指向它。
 * 否则窗口虽然存在，但所有输出都进了空设备 —— 用户看到的就是全黑窗口。
 */
function relaunchInNewConsole() {
  const args = [...process.argv.slice(1), '--relaunched'];
  const cmdline = [process.execPath, ...args].map(winQuote).join(' ');
  try {
    const child = spawn('cmd.exe', ['/d', '/s', '/c', `start "" ${cmdline}`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      cwd: process.cwd(),
      // 关键：让 cmd 自己解析命令行，避免 Node 再加一层引号
      windowsVerbatimArguments: true,
    });
    child.unref();
  } catch {
    /* 忽略，继续用当前（可能不可见的）控制台 */
    return false;
  }
  return true;
}

function writeLastRun(dir, payload) {
  try {
    const { writeFileRetry, mkdirRetry } = require('./fsutil');
    mkdirRetry(dir);
    writeFileRetry(path.join(dir, 'last-run.json'), JSON.stringify(payload, null, 2));
  } catch {
    /* 忽略 */
  }
}

function readLastRun(id) {
  try {
    const file = path.join(itemDir(id), 'last-run.json');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function waitForAnyKey() {
  write('\r\n[StartupManager] 按任意键关闭此窗口…\r\n');
  try {
    spawnSync('cmd.exe', ['/d', '/c', 'pause >nul'], { stdio: stdioForChild() });
  } catch {
    /* 忽略 */
  }
}

function run(id, options = {}) {
  attachConsole();

  // 没有可用的控制台输出句柄：换一个真正带控制台的进程再执行（只重试一次，避免死循环）
  // --run-now 是命令行调试入口，输出要落在当前终端（哪怕被重定向），因此不重启
  if (
    !process.stdout.isTTY &&
    !options.noRelaunch &&
    !process.argv.includes('--relaunched') &&
    relaunchInNewConsole()
  ) {
    process.exit(0);
  }

  const item = config.get(id);
  if (!item) {
    writeErr('[StartupManager] 未找到项目：' + id + '\r\n');
    waitForAnyKey();
    process.exitCode = 2;
    return;
  }

  // --run-now（人工测试）强制不等待按键；计划任务场景仍按项目配置
  const keepOpen = options.keepOpen !== undefined ? !!options.keepOpen : !!(item.console && item.console.keepOpen);

  if (item.kind === 'exe' && item.exePath && !fs.existsSync(item.exePath)) {
    writeErr('[StartupManager] 目标 exe 不存在：' + item.exePath + '\r\n');
    writeErr('[StartupManager] 请在配置界面里修正路径或删除该项目（计划任务会保留，直到删除该项目）。\r\n');
    if (keepOpen) waitForAnyKey();
    process.exitCode = 4;
    return;
  }

  const dir = itemDir(item.id);
  const isPs = item.kind === 'powershell';
  const scriptPath = path.join(dir, isPs ? 'run.ps1' : 'run.cmd');
  if (!fs.existsSync(scriptPath)) {
    writeErr('[StartupManager] 脚本缺失，请在 GUI 中重新保存该项目：' + scriptPath + '\r\n');
    if (keepOpen) waitForAnyKey();
    process.exitCode = 3;
    return;
  }

  // 尽力设置标题；wrapper 内部也会设置（$Host.UI.RawUI / title）
  try {
    process.title = item.name;
  } catch {
    /* 忽略 */
  }

  const startedAt = Date.now();
  const startedIso = new Date().toISOString();

  const child = isPs
    ? spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
        stdio: stdioForChild(),
        windowsHide: false,
      })
    : spawn('cmd.exe', ['/d', '/c', scriptPath], { stdio: stdioForChild(), windowsHide: false });

  let settled = false;
  const finish = (code) => {
    if (settled) return;
    settled = true;
    const durationMs = Date.now() - startedAt;
    const exitCode = Number.isInteger(code) ? code : -1;
    writeLastRun(dir, {
      at: startedIso,
      finishedAt: new Date().toISOString(),
      exitCode,
      durationMs,
      ok: exitCode === 0,
      source: 'runner',
    });
    log.toFile('INFO', '运行结束', item.id, 'exit=' + exitCode, 'ms=' + durationMs);
    write(`\r\n[StartupManager] 结束：用时 ${(durationMs / 1000).toFixed(1)}s，退出码 ${exitCode}\r\n`);
    if (keepOpen) waitForAnyKey();
    process.exit(exitCode);
  };

  child.on('error', (err) => {
    writeErr('\r\n[StartupManager] 启动失败：' + err.message + '\r\n');
    finish(-1);
  });
  child.on('exit', (code, signal) => {
    if (signal) writeErr('\r\n[StartupManager] 被信号终止：' + signal + '\r\n');
    finish(typeof code === 'number' ? code : -1);
  });
}

module.exports = { run, readLastRun };
