'use strict';
/**
 * 发布构建（二选一，不同时产出）：
 *   - 优先：dist/StartupManager.exe        单文件版（Node SEA 注入）
 *   - 兜底：dist/StartupManager/           绿色目录版（原版 node.exe + app.cjs）
 *           dist/StartupManager-green.zip  上述目录的压缩包
 *
 * 中间产物（app.cjs / sea-prep.blob / sea-config.json）全部落在 .build/，构建结束即删除，
 * dist 里只留最终可发布的东西。
 * 单文件版依赖 npm 上的 postject 做注入（首次构建需要联网）。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const TMP = path.join(ROOT, '.build');
const pkg = require(path.join(ROOT, 'package.json'));
const { build } = require('./bundle');

const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const POSTJECT = 'postject@1.0.0-alpha.6';
// --green：跳过单文件版，强制走绿色目录版（用于验证兜底链路）
const FORCE_GREEN = process.argv.includes('--green');

function log(msg) {
  console.log('\n▸ ' + msg);
}

function run(file, args, opts = {}) {
  const r = spawnSync(file, args, { cwd: ROOT, stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`${file} ${args.join(' ')} 失败（退出码 ${r.status}）`);
}

function rmrf(p) {
  // 有进程正在运行 dist 里的 exe 时 Windows 会锁文件；重试几次，失败则提示
  for (let i = 0; i < 5; i += 1) {
    try {
      fs.rmSync(p, { recursive: true, force: true });
      return true;
    } catch (e) {
      if (i === 4) {
        console.warn('⚠ 无法清空 ' + p + '（可能仍有进程在运行）。请先关闭正在运行的 StartupManager 后重试。');
        return false;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200 * (i + 1));
    }
  }
  return false;
}

function writeGreenLaunchers(dir) {
  fs.writeFileSync(
    path.join(dir, 'start.cmd'),
    '@echo off\r\nchcp 65001 >nul\r\ntitle StartupManager\r\ncd /d "%~dp0"\r\n"%~dp0node.exe" "%~dp0app.cjs"\r\nif errorlevel 1 pause\r\n',
    'utf8'
  );

  fs.writeFileSync(
    path.join(dir, '说明.txt'),
    [
      'StartupManager 绿色目录版',
      '',
      'start.cmd         启动配置服务（保留控制台窗口，可看日志）',
      'node.exe          Node.js 运行时',
      'app.cjs           程序本体',
      '',
      '数据目录：%LOCALAPPDATA%\\StartupManager',
      '',
      '注意：整个目录可以任意移动，但移动后请在界面里点一次“重新同步”，',
      '      因为计划任务里记录的是绝对路径。',
      '',
    ].join('\r\n'),
    'utf8'
  );
}

/** 生成 SEA 单文件到 .build/，失败返回 null（不抛错，交由调用方决定兜底） */
function buildSea(appCjs) {
  const exe = path.join(TMP, 'StartupManager.exe');
  const blob = path.join(TMP, 'sea-prep.blob');
  const configPath = path.join(TMP, 'sea-config.json');

  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        main: appCjs.replace(/\\/g, '\\\\'),
        output: blob.replace(/\\/g, '\\\\'),
        disableExperimentalSEAWarning: true,
        useSnapshot: false,
        useCodeCache: false,
      },
      null,
      2
    ),
    'utf8'
  );

  log('生成 SEA blob');
  run(process.execPath, ['--experimental-sea-config', configPath]);

  log('复制 node.exe → StartupManager.exe');
  fs.copyFileSync(process.execPath, exe);

  log('注入 blob（postject）');
  const r = spawnSync(
    'cmd.exe',
    ['/c', 'npx', '--yes', POSTJECT, exe, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', FUSE],
    { cwd: ROOT, stdio: 'inherit' }
  );
  if (r.status !== 0) {
    console.warn('⚠ postject 注入失败（通常是无网络或 npm 源不可达）');
    return null;
  }
  return exe;
}

function verifyExe(exe) {
  const r = spawnSync(exe, ['--version'], { encoding: 'utf8', timeout: 60000 });
  const out = (r.stdout || '').trim();
  if (r.status !== 0 || !out) {
    console.warn('⚠ 单文件版自检失败：' + (r.stderr || out || '（无输出）').slice(0, 300));
    return false;
  }
  console.log('  自检通过：' + out);
  return true;
}

function buildGreenFallback(appCjs) {
  const dir = path.join(DIST, 'StartupManager');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(process.execPath, path.join(dir, 'node.exe'));
  fs.writeFileSync(path.join(dir, 'app.cjs'), fs.readFileSync(appCjs));
  writeGreenLaunchers(dir);

  const zip = path.join(DIST, 'StartupManager-green.zip');
  const r = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `Compress-Archive -Path '${dir}\\*' -DestinationPath '${zip}' -Force`],
    { cwd: ROOT, stdio: 'inherit' }
  );
  if (r.status !== 0) console.warn('⚠ 压缩包生成失败，可直接使用 dist\\StartupManager\\ 目录');
  return dir;
}

function main() {
  log('清理 dist 与 .build');
  rmrf(DIST);
  rmrf(TMP);
  fs.mkdirSync(DIST, { recursive: true });
  fs.mkdirSync(TMP, { recursive: true });

  log('打包 app.cjs');
  const appBundle = build(pkg.version);
  const appCjs = path.join(TMP, 'app.cjs');
  fs.writeFileSync(appCjs, appBundle, 'utf8');
  console.log('  大小 ' + (Buffer.byteLength(appBundle) / 1024).toFixed(1) + ' KB');

  log('冒烟：--version');
  const v = spawnSync(process.execPath, [appCjs, '--version'], { encoding: 'utf8' });
  if (v.status !== 0) throw new Error('打包产物无法运行：' + (v.stderr || '').slice(0, 500));
  console.log('  输出 ' + v.stdout.trim());

  let exe = null;
  if (FORCE_GREEN) {
    log('按要求跳过单文件版（--green）');
  } else {
    try {
      log('构建单文件版');
      exe = buildSea(appCjs);
    } catch (e) {
      console.warn('⚠ 单文件版构建异常：' + e.message);
      exe = null;
    }
  }

  let ok = false;
  if (exe && fs.existsSync(exe)) {
    log('自检并落地到 dist');
    ok = verifyExe(exe);
    if (ok) {
      fs.copyFileSync(exe, path.join(DIST, 'StartupManager.exe'));
    }
  }

  if (!ok) {
    log('单文件版不可用，改用绿色目录版');
    rmrf(DIST);
    fs.mkdirSync(DIST, { recursive: true });
    const dir = buildGreenFallback(appCjs);
    console.log('  ' + dir);
  }

  rmrf(TMP);

  log('完成');
  const items = fs.readdirSync(DIST);
  console.log('  dist 内容：' + items.join('、'));
  if (items.includes('StartupManager.exe')) {
    const mb = (fs.statSync(path.join(DIST, 'StartupManager.exe')).size / 1024 / 1024).toFixed(1);
    console.log('  单文件版：dist\\StartupManager.exe（' + mb + ' MB）');
  } else {
    console.log('  绿色目录版：dist\\StartupManager\\start.cmd');
  }
  console.log('  数据目录：%LOCALAPPDATA%\\StartupManager');
}

main();
