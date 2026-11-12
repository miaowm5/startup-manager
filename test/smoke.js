'use strict';
/**
 * 端到端冒烟测试（通过 HTTP 调用真实服务）。
 * 用法：SM_DATA_DIR=<数据目录> node test/smoke.js
 * 前置：服务已在 SM_BASE（默认 18777）上以 SM_FAKE_TASKS=1 启动。
 */
const fs = require('fs');
const path = require('path');

const BASE = process.env.SM_BASE || 'http://127.0.0.1:18777';
const DATA = process.env.SM_DATA_DIR;
if (!DATA) {
  console.error('缺少 SM_DATA_DIR');
  process.exit(2);
}
const info = JSON.parse(fs.readFileSync(path.join(DATA, 'server.json'), 'utf8'));
const TOKEN = info.token;

let pass = 0;
let fail = 0;

function check(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log('  ✓ ' + name);
  } else {
    fail += 1;
    console.log('  ✗ ' + name + (extra ? '  → ' + JSON.stringify(extra).slice(0, 400) : ''));
  }
}

async function call(method, p, body, opts = {}) {  const headers = {};
  if (!opts.noAuth) headers.Authorization = 'Bearer ' + TOKEN;
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    if (!opts.noCsrf) headers['X-SM-Request'] = '1';
  }
  if (opts.host) headers.Host = opts.host;
  const res = await fetch(BASE + p, {
    method,
    headers,
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

/**
 * fetch 不允许自定义 Host 头，这里用 node:http 直连来验证 DNS rebinding 防护。
 */
function rawGet(pathname, hostHeader) {
  const http = require('http');
  const u = new URL(BASE);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: u.hostname, port: u.port, path: pathname, method: 'GET', headers: { Host: hostHeader, Authorization: 'Bearer ' + TOKEN } },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  console.log('\n[1] 系统信息');
  const sys = await call('GET', '/api/system');
  check('GET /api/system = 200', sys.status === 200, sys);
  check('测试模式标记', sys.json.app && sys.json.app.fakeScheduler === true, sys.json.app);

  console.log('\n[2] 鉴权与安全');
  const noAuth = await call('GET', '/api/items', null, { noAuth: true });
  check('无 token → 401', noAuth.status === 401, noAuth);
  const noCsrf = await call('POST', '/api/items', { name: 'x' }, { noCsrf: true });
  check('缺 X-SM-Request → 403', noCsrf.status === 403, noCsrf);
  const badHost = await rawGet('/api/items', 'evil.example.com');
  check('非法 Host → 421', badHost.status === 421, badHost);

  console.log('\n[3] 新建 PowerShell 项目');
  const psItem = {
    name: '测试-PS',
    kind: 'powershell',
    command: 'Write-Output "hello 中文"\nWrite-Output $PWD',
    workingDirectory: DATA,
    trigger: { delaySeconds: 5 },
    runLevel: 'limited',
    console: { keepOpen: false },
    enabled: true,
  };
  const created = await call('POST', '/api/items', psItem);
  check('POST /api/items = 200', created.status === 200, created);
  const psId = created.json.item && created.json.item.id;
  check('返回项目 id', !!psId);
  check('任务已注册（fake）', created.json.item && created.json.item.task && created.json.item.task.state === 'Ready', created.json.item && created.json.item.task);
  check('无漂移', created.json.item && created.json.item.drift === null, created.json.item && created.json.item.drift);

  console.log('\n[4] 生成的脚本');
  const scriptPath = path.join(DATA, 'items', psId, 'run.ps1');
  check('run.ps1 已生成', fs.existsSync(scriptPath));
  const raw = fs.readFileSync(scriptPath);
  check('UTF-8 BOM', raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf, raw.slice(0, 3));
  const body = raw.toString('utf8');
  check('包含用户命令', body.includes('Write-Output "hello 中文"'));
  check('包含路径切换', body.includes('Set-Location -LiteralPath'));
  check('包含结束标记', body.includes('脚本执行完毕'));
  check('不在脚本内谎报退出码（退出码由宿主汇总）', !body.includes('$__smCode'));
  check('不用 Start-Transcript（输出由宿主转发落盘）', !body.includes('Start-Transcript'));

  const preview = await call('GET', `/api/items/${psId}/script`);
  check('GET script = 200', preview.status === 200 && preview.json.content.includes('StartupManager'), preview.status);

  console.log('\n[5] 新建 exe 项目');
  const exeItem = {
    name: '测试-EXE',
    kind: 'exe',
    exePath: 'C:\\Windows\\System32\\cmd.exe',
    arguments: '/c echo hi',
    trigger: { delaySeconds: 0 },
    console: { keepOpen: true },
    enabled: true,
  };
  const createdExe = await call('POST', '/api/items', exeItem);
  check('POST exe = 200', createdExe.status === 200, createdExe);
  const exeId = createdExe.json.item && createdExe.json.item.id;
  check('返回项不再带 openWith', createdExe.json.item && createdExe.json.item.openWith === undefined, createdExe.json.item);
  const cmdPath = path.join(DATA, 'items', exeId, 'run.cmd');
  check('run.cmd 已生成', fs.existsSync(cmdPath));
  const cmdBody = fs.readFileSync(cmdPath, 'utf8');
  check('cmd 含 chcp 65001', cmdBody.includes('chcp 65001'));
  check('cmd 含退出码', cmdBody.includes('exit /b'));
  check('cmd 无 BOM', !cmdBody.startsWith('\uFEFF'));
  check('exe 统一用系统默认程序打开（start ""）', cmdBody.includes('start "" "C:\\Windows\\System32\\cmd.exe"'));
  check('不再直接调用目标文件', !/(^|\r?\n)"C:\\Windows\\System32\\cmd\.exe"/.test(cmdBody));

  // 文档类 / 任意扩展名也不再需要手动勾选；旧配置里的 openWith 会被忽略
  const createdShell = await call('POST', '/api/items', {
    name: '测试-文档',
    kind: 'exe',
    exePath: 'C:\\Windows\\win.ini',
    openWith: 'direct',
    trigger: { delaySeconds: 0 },
    enabled: false,
  });
  check('POST 文档类 = 200', createdShell.status === 200, createdShell);
  check('旧的 openWith 字段被忽略', createdShell.json.item && createdShell.json.item.openWith === undefined, createdShell.json.item);
  const shellId = createdShell.json.item && createdShell.json.item.id;
  const shellBody = fs.readFileSync(path.join(DATA, 'items', shellId, 'run.cmd'), 'utf8');
  check('文档类也用 start "" 打开', shellBody.includes('start "" "C:\\Windows\\win.ini"'));
  await call('DELETE', `/api/items/${shellId}`);

  console.log('\n[6] 列表与校验');
  const list = await call('GET', '/api/items');
  check('列表 2 项', list.json.items && list.json.items.length === 2, list.json.items && list.json.items.length);
  const delays = (list.json.items || []).map((it) => it.trigger.delaySeconds);
  check('列表按登录延迟升序', delays.every((d, i) => i === 0 || delays[i - 1] <= d), delays);
  const badItem = await call('POST', '/api/items', { name: '', kind: 'powershell', command: '' });
  check('空名称/空命令 → 400', badItem.status === 400, badItem);
  check('返回 errors', Array.isArray(badItem.json.errors) && badItem.json.errors.length >= 2, badItem.json.errors);
  const badExe = await call('POST', '/api/items', { name: 'x', kind: 'exe', exePath: 'relative.exe' });
  check('相对路径 exe → 400', badExe.status === 400, badExe);

  // 不再限制扩展名：所有文件都交给系统默认程序
  const anyExt = await call('POST', '/api/items', {
    name: 'x-any-ext',
    kind: 'exe',
    exePath: 'C:\\Windows\\notepad.psd',
    trigger: { delaySeconds: 0 },
    enabled: false,
  });
  check('任意扩展名（.psd）→ 200', anyExt.status === 200, anyExt);
  if (anyExt.json.item) {
    const anyBody = fs.readFileSync(path.join(DATA, 'items', anyExt.json.item.id, 'run.cmd'), 'utf8');
    check('.psd 生成 start ""', anyBody.includes('start ""'));
    await call('DELETE', `/api/items/${anyExt.json.item.id}`);
  }

  // .ps1 能保存，但要提示应该用「PowerShell 命令」类型
  const ps1Item = await call('POST', '/api/items', {
    name: 'x-ps1',
    kind: 'exe',
    exePath: 'C:\\Windows\\notepad.ps1',
    trigger: { delaySeconds: 0 },
    enabled: false,
  });
  const ps1Warnings = (ps1Item.json && ps1Item.json.warnings) || [];
  check('.ps1 → 200 且提示改用 PowerShell 类型', ps1Item.status === 200 && ps1Warnings.some((w) => w.includes('PowerShell')), ps1Item.json);
  if (ps1Item.json.item) await call('DELETE', `/api/items/${ps1Item.json.item.id}`);

  console.log('\n[7] 更新 / 启停 / 同步');
  const updated = await call('PUT', `/api/items/${psId}`, { name: '测试-PS-改名', trigger: { delaySeconds: 30 } });
  check('PUT = 200', updated.status === 200, updated);
  check('名称已改', updated.json.item.name === '测试-PS-改名', updated.json.item.name);
  check('延迟已改', updated.json.item.trigger.delaySeconds === 30, updated.json.item.trigger);

  const disabled = await call('POST', `/api/items/${psId}/disable`, {});
  check('disable = 200', disabled.status === 200 && disabled.json.item.enabled === false, disabled.json.item && disabled.json.item.enabled);
  const enabled = await call('POST', `/api/items/${psId}/enable`, {});
  check('enable = 200', enabled.status === 200 && enabled.json.item.enabled === true, enabled.json.item && enabled.json.item.enabled);

  const resync = await call('POST', '/api/tasks/resync', {});
  check('resync = 200 且全部成功', resync.status === 200 && resync.json.results.every((r) => r.ok), resync.json.results);
  check('resync 带 denied 标记', resync.json.denied === false, resync.json.denied);

  console.log('\n[8] 预览（未保存草稿）');
  const prev = await call('POST', '/api/preview', {
    name: '草稿',
    kind: 'powershell',
    command: 'Get-Date',
    trigger: { delaySeconds: 3 },
  });
  check('POST /api/preview = 200', prev.status === 200, prev.status);
  check('预览含命令', prev.json.content && prev.json.content.includes('Get-Date'), prev.json.content && prev.json.content.slice(0, 120));
  check('预览文件名 run.ps1', prev.json.fileName === 'run.ps1', prev.json.fileName);

  console.log('\n[9] 删除与清理');
  const del1 = await call('DELETE', `/api/items/${psId}`);
  check('DELETE ps = 200', del1.status === 200, del1);
  check('目录已清理', !fs.existsSync(path.join(DATA, 'items', psId)));
  const del2 = await call('DELETE', `/api/items/${exeId}`);
  check('DELETE exe = 200', del2.status === 200, del2);
  const list2 = await call('GET', '/api/items');
  check('列表已空', list2.json.items.length === 0, list2.json.items.length);

  const notFound = await call('DELETE', '/api/items/does-not-exist');
  check('删除不存在 → 404', notFound.status === 404, notFound.status);

  console.log('\n[10] 权限提示与解码');
  const { decodePowerShell } = require('../src/textcodec');
  const schedMod = require('../src/sched');
  const utf8Denied = Buffer.from('拒绝访问。', 'utf8');
  check('PowerShell 输出按 UTF-8 解码（不再乱码）', decodePowerShell(utf8Denied) === '拒绝访问。', decodePowerShell(utf8Denied));
  check('能识别英文 Access is denied', schedMod.isAccessDenied('ERROR: Access is denied.'), schedMod.isAccessDenied('ERROR: Access is denied.'));
  check('能识别中文「拒绝访问」', schedMod.isAccessDenied('错误：拒绝访问。'), schedMod.isAccessDenied('错误：拒绝访问。'));
  check('友好提示包含管理员指引', /管理员/.test(schedMod.PERMISSION_HINT), schedMod.PERMISSION_HINT);
  const sys2 = await call('GET', '/api/system');
  check('system 带调度器状态', sys2.json.scheduler && sys2.json.scheduler.fake === true, sys2.json.scheduler);

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
