'use strict';
/**
 * 控制台可见性探针：验证「直接运行」弹出的窗口里，子进程的 stdout 到底接没接到控制台。
 * NUL 设备上 GetConsoleMode 会失败，真控制台会成功 —— 这是判定"窗口全黑"的硬指标。
 *
 * 用法：先启动服务，再 node test/console-probe.js <base> <token>
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const BASE = process.argv[2] || 'http://127.0.0.1:8767';
const TOKEN = process.argv[3];
if (!TOKEN) {
  console.error('用法: node test/console-probe.js <base> <token>');
  process.exit(2);
}

const probeFile = path.join(os.tmpdir(), 'sm-console-probe.txt');
try {
  fs.unlinkSync(probeFile);
} catch {
  /* 忽略 */
}

const command = [
  `Add-Type -MemberDefinition '[DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr GetStdHandle(int n); [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool WriteConsoleW(IntPtr h, string s, uint len, out uint written, IntPtr reserved);' -Name K -Namespace W`,
  '$h = [W.K]::GetStdHandle(-11)',
  '$written = 0',
  // WriteConsoleW 对 NUL 设备会失败、对真控制台成功，且不需要读权限 —— 判定"窗口是否真的能看到内容"
  '$ok = [W.K]::WriteConsoleW($h, "SM-PROBE-VISIBLE", 17, [ref]$written, [IntPtr]::Zero)',
  'Set-Content -LiteralPath $env:PROBE_FILE -Value ("writeConsole=" + $ok + ";written=" + $written) -Encoding utf8',
  'Start-Sleep -Seconds 10',
].join('\n');

async function call(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: {
      Authorization: 'Bearer ' + TOKEN,
      ...(method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-SM-Request': '1' }),
    },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

(async () => {
  const created = await call('POST', '/api/items', {
    name: 'console-probe',
    kind: 'powershell',
    command,
    env: { PROBE_FILE: probeFile },
    trigger: { delaySeconds: 0 },
    console: { keepOpen: true },
    enabled: true,
  });
  if (created.status !== 200) {
    console.error('创建失败', created);
    process.exit(1);
  }
  const id = created.json.item.id;

  const mode = process.argv[4] || 'run';
  if (mode === 'task') {
    const { spawnSync } = require('child_process');
    const r = spawnSync('schtasks.exe', ['/Run', '/TN', '\\StartupManager\\' + id], { windowsHide: true });
    console.log('已通过计划任务启动 schtasks status=', r.status);
  } else {
    const run = await call('POST', `/api/items/${id}/run`, {});
    console.log('已触发直接运行 pid=', run.json.pid);
  }

  for (let i = 0; i < 20; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    if (fs.existsSync(probeFile)) break;
  }

  let result = '(未产生探针文件)';
  try {
    result = fs.readFileSync(probeFile, 'utf8').trim();
  } catch {
    /* 忽略 */
  }
  console.log('探针结果:', result);
  console.log(result.includes('writeConsole=True') ? '✔ stdout 已接到控制台（窗口能看到内容）' : '✘ stdout 没接到控制台（窗口会是黑的）');

  await call('DELETE', `/api/items/${id}`);
  console.log('已清理测试项');
})();
