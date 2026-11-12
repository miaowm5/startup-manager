'use strict';
/**
 * 计划任务注册器。
 *
 * 主路径用原生 schtasks.exe：注册 49ms / 查询 37ms / 启停 25ms / 删除 22ms。
 * 早期版本全部走 PowerShell（每次 2.5–3.3 秒，因为要加载 ScheduledTasks 模块），
 * 一次保存会串行触发多次，用户要等 8 秒左右才看到任务刷新 —— 所以改成原生优先。
 * PowerShell 保留为兜底：XML 被策略拒收、schtasks 被组策略禁用等情况下自动回退。
 *
 * 统一使用「登录触发 + 交互式令牌 + 不隐藏」的任务，保证控制台窗口可见。
 * SM_FAKE_TASKS=1 时不真正操作调度器，便于在受限环境做全链路测试。
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SEA, ROOT, PORTABLE } = require('./paths');
const { decodeConsole, normalizeState } = require('./textcodec');
const { effectiveWorkingDirectory } = require('./config');
const log = require('./log');

const TASK_PATH = '\\StartupManager\\';
const FAKE = process.env.SM_FAKE_TASKS === '1';
const fakeTasks = new Map();

const NOT_FOUND_RE = /cannot find|not exist|no tasks|找不到|不存在|没有|0x80070002|0x80070490/i;

function isFake() {
  return FAKE;
}

/** 计划任务 Action 要执行的程序（SEA 单文件 = 自身；开发/绿色目录 = node + 入口脚本） */
function runnerCommand() {
  const base = SEA
    ? { exe: process.execPath, args: [] }
    : { exe: process.execPath, args: [process.argv[1] ? path.resolve(process.argv[1]) : path.join(__dirname, 'main.js')] };
  // 数据目录不在默认位置时，必须显式传给宿主，否则任务进程会去找 %LOCALAPPDATA%
  if (PORTABLE) base.args = [...base.args, '--data-dir', ROOT];
  return base;
}

function taskFullName(id) {
  return TASK_PATH + id;
}

function quoteWin(arg) {
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

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function currentUser() {
  return `${process.env.USERDOMAIN || ''}\\${process.env.USERNAME || ''}`.replace(/^\\/, '');
}

function buildTaskXml(item) {
  const cmd = runnerCommand();
  const args = [...cmd.args, '--run', item.id].map(quoteWin).join(' ');
  const runLevel = item.runLevel === 'highest' ? 'HighestAvailable' : 'LeastPrivilege';
  const delay = Math.max(0, Number(item.trigger && item.trigger.delaySeconds) || 0);
  const enabled = item.enabled !== false;

  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>${xmlEscape(currentUser())}</Author>
    <Description>${xmlEscape('StartupManager: ' + item.name)}</Description>
    <URI>${xmlEscape(TASK_PATH + item.id)}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xmlEscape(currentUser())}</UserId>
      <Delay>PT${delay}S</Delay>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlEscape(currentUser())}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>${runLevel}</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>${enabled}</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(cmd.exe)}</Command>
      <Arguments>${xmlEscape(args)}</Arguments>
      <WorkingDirectory>${xmlEscape(effectiveWorkingDirectory(item) || path.dirname(cmd.exe))}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>`;
}

/* ---------------------------------- 原生 schtasks ---------------------------------- */

function schtasks(args, timeout = 20000) {
  // 不指定 encoding：拿原始 Buffer，再按控制台代码页解码（见 textcodec）
  const r = spawnSync('schtasks.exe', args, { timeout, windowsHide: true });
  return {
    code: typeof r.status === 'number' ? r.status : -1,
    out: decodeConsole(r.stdout).trim(),
    err: decodeConsole(r.stderr).trim(),
  };
}

/** 解析一行 CSV（schtasks 输出字段用双引号包裹，内部不含转义引号） */
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuote = false;
  for (const ch of line) {
    if (ch === '"') {
      inQuote = !inQuote;
    } else if (ch === ',' && !inQuote) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/* ---------------------------------- 写操作 ---------------------------------- */

function applyItem(item) {
  if (FAKE) {
    fakeTasks.set(item.id, {
      state: item.enabled === false ? 'Disabled' : 'Ready',
      enabled: item.enabled !== false,
      lastRun: null,
      lastResult: null,
      nextRun: null,
    });
    log.info('[fake] register task', item.id, item.name);
    return { ok: true, fake: true, state: item.enabled === false ? 'Disabled' : 'Ready' };
  }

  const xml = buildTaskXml(item);
  const file = path.join(os.tmpdir(), `startupmanager-${process.pid}-${Date.now()}.xml`);
  try {
    fs.writeFileSync(file, Buffer.from('\uFEFF' + xml, 'utf16le'));
    const full = taskFullName(item.id);
    let r = schtasks(['/Create', '/TN', full, '/XML', file, '/F']);
    if (r.code !== 0 && /already exists|running|已存在|正在运行/i.test(r.out + r.err)) {
      schtasks(['/Delete', '/TN', full, '/F']);
      r = schtasks(['/Create', '/TN', full, '/XML', file, '/F']);
    }
    if (r.code !== 0) {
      log.warn('schtasks 注册失败，回退 PowerShell：', (r.out || r.err).slice(0, 300));
      return applyItemPs(item, xml);
    }
    const state = item.enabled === false ? 'Disabled' : 'Ready';
    return { ok: true, state };
  } finally {
    try {
      fs.unlinkSync(file);
    } catch {
      /* 忽略 */
    }
  }
}

function removeItem(id) {
  if (FAKE) {
    fakeTasks.delete(id);
    return { ok: true, fake: true };
  }
  const r = schtasks(['/Delete', '/TN', taskFullName(id), '/F']);
  if (r.code === 0) return { ok: true };
  if (NOT_FOUND_RE.test(r.out + r.err)) return { ok: true, alreadyGone: true };
  return removeItemPs(id);
}

function setEnabled(id, on) {
  if (FAKE) {
    const t = fakeTasks.get(id);
    if (t) {
      t.enabled = !!on;
      t.state = on ? 'Ready' : 'Disabled';
    }
    return { ok: true, fake: true, state: on ? 'Ready' : 'Disabled' };
  }
  const r = schtasks(['/Change', '/TN', taskFullName(id), on ? '/ENABLE' : '/DISABLE']);
  if (r.code === 0) return { ok: true, state: on ? 'Ready' : 'Disabled' };
  if (NOT_FOUND_RE.test(r.out + r.err)) return { ok: false, error: '任务不存在' };
  return setEnabledPs(id, on);
}

function listTasks() {
  if (FAKE) {
    const tasks = [...fakeTasks.entries()].map(([name, t]) => ({ name, ...t }));
    return { ok: true, tasks, fake: true };
  }

  const r = schtasks(['/Query', '/TN', TASK_PATH, '/FO', 'CSV', '/NH']);
  if (r.code !== 0) {
    if (NOT_FOUND_RE.test(r.out + r.err)) return { ok: true, tasks: [] };
    log.warn('schtasks 查询失败，回退 PowerShell：', (r.out || r.err).slice(0, 200));
    return listTasksPs();
  }

  const tasks = [];
  for (const line of r.out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cols = parseCsvLine(line);
    if (cols.length < 3) continue;
    const full = cols[0];
    const name = full.split('\\').filter(Boolean).pop();
    if (!name) continue;
    const state = normalizeState(cols[2] || '');
    tasks.push({
      name,
      state,
      enabled: state !== 'Disabled',
      lastRun: null,
      lastResult: null,
      nextRun: cols[1] && cols[1] !== 'N/A' ? cols[1] : null,
    });
  }
  return { ok: true, tasks };
}

/** 是否以提升权限运行：看完整性级别 SID（进程若被 UAC 过滤会是 Medium） */
function isElevated() {
  try {
    const r = spawnSync('whoami.exe', ['/groups', '/fo', 'csv', '/nh'], { windowsHide: true });
    return /S-1-16-12288|S-1-16-16384/.test(decodeConsole(r.stdout));
  } catch {
    return false;
  }
}

function probe() {
  if (FAKE) return { ok: true, fake: true, admin: false };
  const r = schtasks(['/Query', '/TN', TASK_PATH, '/FO', 'CSV', '/NH']);
  let ok = true;
  let error = null;
  if (r.code !== 0 && !NOT_FOUND_RE.test(r.out + r.err)) {
    ok = false;
    error = (r.out || r.err).slice(0, 300);
  }
  return { ok, admin: isElevated(), error };
}

/* ---------------------------------- PowerShell 兜底 ---------------------------------- */

const PREAMBLE = [
  "$ProgressPreference = 'SilentlyContinue'",
  '$ErrorActionPreference = "Stop"',
  // 强制 UTF-8 输出，避免中文错误信息被按控制台代码页解码后变乱码
  'try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }',
  '',
].join('\n');

function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

function psRun(script, timeout = 45000) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const r = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { timeout, windowsHide: true }
  );
  const stdout = decodeConsole(r.stdout).trim();
  const stderr = decodeConsole(r.stderr).trim();
  let payload = null;
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (line.startsWith('{')) {
      try {
        payload = JSON.parse(line);
        break;
      } catch {
        /* 继续向前找 */
      }
    }
  }
  if (!payload) return { ok: false, error: stderr || stdout || `PowerShell 退出码 ${r.status}`, raw: stdout };
  if (stderr && !stderr.startsWith('#< CLIXML')) log.warn('PowerShell stderr:', stderr.slice(0, 400));
  return payload;
}

function applyItemPs(item, xml) {
  const b64 = Buffer.from(xml, 'utf8').toString('base64');
  const script = PREAMBLE + `
$taskPath = ${psQuote(TASK_PATH)}
$taskName = ${psQuote(item.id)}
$xml = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String(${psQuote(b64)}))
$res = @{ ok = $true; error = $null; state = $null }
try {
  $existing = Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction SilentlyContinue
  if ($existing) {
    Unregister-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Confirm:$false -ErrorAction Stop
  }
  Register-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Xml $xml -ErrorAction Stop | Out-Null
  $t = Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction SilentlyContinue
  if ($t) { $res.state = [string]$t.State }
} catch {
  $res.ok = $false
  $res.error = $_.Exception.Message
}
$res | ConvertTo-Json -Compress
`;
  const res = psRun(script);
  if (!res.ok) log.error('注册任务失败', item.id, res.error);
  return res;
}

function removeItemPs(id) {
  const script = PREAMBLE + `
$taskPath = ${psQuote(TASK_PATH)}
$taskName = ${psQuote(id)}
$res = @{ ok = $true; error = $null }
try {
  if (Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Confirm:$false -ErrorAction Stop
  }
} catch {
  $res.ok = $false
  $res.error = $_.Exception.Message
}
$res | ConvertTo-Json -Compress
`;
  return psRun(script);
}

function setEnabledPs(id, on) {
  const script = PREAMBLE + `
$taskPath = ${psQuote(TASK_PATH)}
$taskName = ${psQuote(id)}
$verb = ${on ? "'Enable-ScheduledTask'" : "'Disable-ScheduledTask'"}
$res = @{ ok = $true; error = $null; state = $null }
try {
  if (Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction SilentlyContinue) {
    & $verb -TaskPath $taskPath -TaskName $taskName -ErrorAction Stop | Out-Null
    $res.state = ${on ? "'Ready'" : "'Disabled'"}
  } else {
    $res.ok = $false
    $res.error = '任务不存在'
  }
} catch {
  $res.ok = $false
  $res.error = $_.Exception.Message
}
$res | ConvertTo-Json -Compress
`;
  return psRun(script);
}

function listTasksPs() {
  const script = PREAMBLE + `
$out = @()
try {
  Get-ScheduledTask -TaskPath ${psQuote(TASK_PATH + '*')} -ErrorAction SilentlyContinue | ForEach-Object {
    $out += [pscustomobject]@{
      name    = $_.TaskName
      state   = [string]$_.State
      enabled = [bool]$_.Settings.Enabled
      lastRun = $null
      lastResult = $null
      nextRun = $null
    }
  }
  @{ ok = $true; tasks = @($out); error = $null } | ConvertTo-Json -Compress -Depth 4
} catch {
  @{ ok = $false; tasks = @(); error = $_.Exception.Message } | ConvertTo-Json -Compress -Depth 4
}
`;
  const res = psRun(script);
  if (!res.ok && NOT_FOUND_RE.test(String(res.error || ''))) return { ok: true, tasks: [] };
  return { ok: !!res.ok, tasks: Array.isArray(res.tasks) ? res.tasks : [], error: res.error || null };
}

module.exports = {
  TASK_PATH,
  isFake,
  runnerCommand,
  buildTaskXml,
  quoteWin,
  applyItem,
  removeItem,
  setEnabled,
  listTasks,
  probe,
  currentUser,
};
