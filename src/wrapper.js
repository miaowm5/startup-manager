'use strict';
/**
 * 自启脚本生成器。
 *
 * 设计要点：用户命令不拼进计划任务的命令行，而是落到独立脚本文件里。
 * 好处：绕开 cmd/PowerShell 引号嵌套、不受命令行长度限制、编码可控（PS 5.1 必须 UTF-8 BOM）、
 *       且前端可原样预览"实际会执行什么"，便于审计。
 */
const fs = require('fs');
const path = require('path');
const { itemDir } = require('./paths');
const { effectiveWorkingDirectory } = require('./config');

const BOM = '\uFEFF';

/**
 * 脚本模板版本。凡是会改变生成脚本内容的改动（调用方式、编码、环境变量处理…）都要 +1，
 * 这样已存在的项目能被识别为"脚本过期"，启动时自动重写，用户不用手工点重新同步。
 */
const TEMPLATE_VERSION = 2;

/** PowerShell 单引号字面量，内部单引号翻倍 */
function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

/** 控制台标题：去掉会破坏 title 命令或批处理的字符 */
function safeTitle(name) {
  const t = String(name || 'StartupManager')
    .replace(/[&|<>^%"'`\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return t || 'StartupManager';
}

function buildPowershell(item) {
  const L = [];
  const ts = new Date().toISOString();
  L.push('# ============================================================');
  L.push('# 由 StartupManager 自动生成。手工修改会在下次保存时被覆盖。');
  L.push('# 项目：' + item.name);
  L.push('# 生成：' + ts);
  L.push('# ============================================================');
  L.push('# sm-template: ' + TEMPLATE_VERSION);
  L.push('');
  L.push('$ErrorActionPreference = "Continue"');
  L.push('$ProgressPreference = "SilentlyContinue"');
  L.push('$Host.UI.RawUI.WindowTitle = ' + psQuote(safeTitle(item.name)));
  L.push('try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }');
  const cwd = effectiveWorkingDirectory(item);
  if (cwd) L.push('Set-Location -LiteralPath ' + psQuote(cwd));
  for (const [k, v] of Object.entries(item.env || {})) L.push('$env:' + k + ' = ' + psQuote(v));
  L.push('');
  L.push('Write-Host ""');
  L.push('Write-Host ' + psQuote('[StartupManager] === ' + item.name + ' ===') + ' -ForegroundColor Cyan');
  L.push('Write-Host ("[StartupManager] 启动于 " + (Get-Date -Format "yyyy-MM-dd HH:mm:ss")) -ForegroundColor DarkGray');
  L.push('$__smStart = Get-Date');
  L.push('$global:LASTEXITCODE = 0');
  L.push('');
  L.push('try {');
  // 用户命令原样插入（不缩进：避免破坏 here-string 内容）
  const cmdLines = String(item.command || '').replace(/\r\n/g, '\n').split('\n');
  for (const line of cmdLines) L.push(line);
  L.push('}');
  L.push('catch {');
  L.push('    Write-Host ("[StartupManager] 执行异常：" + $_.Exception.Message) -ForegroundColor Red');
  L.push('}');
  L.push('finally {');
  L.push('    $__smSec  = [math]::Round(((Get-Date) - $__smStart).TotalSeconds, 1)');
  L.push('    Write-Host ("[StartupManager] 脚本执行完毕，用时 {0}s（退出码见下方宿主汇总）" -f $__smSec) -ForegroundColor DarkGray');
  L.push('}');
  L.push('');
  return L.join('\r\n');
}

function buildCmd(item) {
  const L = [];
  L.push('@echo off');
  L.push('rem sm-template: ' + TEMPLATE_VERSION);
  L.push('chcp 65001 >nul');
  L.push('title ' + safeTitle(item.name));
  for (const [k, v] of Object.entries(item.env || {})) {
    L.push(`set "${k}=${String(v).replace(/"/g, '')}"`);
  }
  const cwd = effectiveWorkingDirectory(item);
  if (cwd) L.push('cd /d "' + cwd + '"');
  L.push('echo.');
  L.push('echo [StartupManager] item ' + item.id);
  L.push('echo [StartupManager] start %DATE% %TIME%');
  L.push('echo.');
  const args = String(item.arguments || '').trim();
  // .bat/.cmd 必须用 call 调用，否则批处理控制权转移、不会返回，
  // 导致后面的退出码汇总与 keepOpen 都不执行
  const ext = path.extname(item.exePath || '').toLowerCase();
  const isBatch = ext === '.bat' || ext === '.cmd';
  if (item.openWith === 'default') {
    // 交给系统关联程序打开（xlsx/pdf/图片…），不等待其退出
    L.push('start "" "' + item.exePath + '"' + (args ? ' ' + args : ''));
  } else {
    L.push((isBatch ? 'call ' : '') + '"' + item.exePath + '"' + (args ? ' ' + args : ''));
  }
  L.push('set "__smCode=%ERRORLEVEL%"');
  L.push('echo.');
  L.push('echo [StartupManager] process exited, code %__smCode%');
  L.push('exit /b %__smCode%');
  L.push('');
  return L.join('\r\n');
}

/** 返回 { fileName, content, encoding } */
function generate(item) {
  if (item.kind === 'exe') {
    return { fileName: 'run.cmd', content: buildCmd(item), bom: false };
  }
  return { fileName: 'run.ps1', content: buildPowershell(item), bom: true };
}

/** 生成并落盘，返回 { filePath, content, fileName } */
function writeWrapper(item) {
  const { writeFileRetry, mkdirRetry } = require('./fsutil');
  const dir = itemDir(item.id);
  mkdirRetry(dir);
  const gen = generate(item);
  const filePath = path.join(dir, gen.fileName);
  const text = gen.bom ? BOM + gen.content : gen.content;
  writeFileRetry(filePath, text);
  // 清掉另一形态的残留脚本，避免混淆
  const stale = path.join(dir, item.kind === 'exe' ? 'run.ps1' : 'run.cmd');
  if (fs.existsSync(stale)) {
    try {
      fs.unlinkSync(stale);
    } catch {
      /* 忽略 */
    }
  }
  return { filePath, fileName: gen.fileName, content: gen.content };
}

function preview(item) {
  const gen = generate(item);
  return { fileName: gen.fileName, content: gen.content };
}

module.exports = { generate, writeWrapper, preview, psQuote, safeTitle, TEMPLATE_VERSION };
