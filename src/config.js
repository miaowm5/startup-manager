'use strict';
/**
 * 配置存储（单一事实源）。
 * 写入采用「临时文件 + 原子替换」，旧文件留一份 .bak，损坏文件另存不静默丢弃。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { files, ensureDirs } = require('./paths');
const log = require('./log');

const DEFAULT_DELAY = 20;
let state = null;

function emptyDoc() {
  return { version: 1, items: [] };
}

function clampInt(v, min, max, dflt) {  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

function normalizeEnv(env) {
  const out = {};
  if (!env || typeof env !== 'object') return out;
  for (const [k, v] of Object.entries(env)) {
    const key = String(k).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    out[key] = String(v ?? '');
  }
  return out;
}

/**
 * 合并入参到标准化项目。existing 存在时，未提供的字段沿用旧值（支持 PATCH 式更新）。
 */
function normalizeItem(input, existing) {
  const now = new Date().toISOString();
  const ex = existing || null;
  const src = input || {};
  const pick = (k, dflt) => {
    if (src[k] !== undefined && src[k] !== null) return src[k];
    if (ex && ex[k] !== undefined && ex[k] !== null) return ex[k];
    return dflt;
  };
  const trig = src.trigger ?? (ex && ex.trigger) ?? {};
  const cons = src.console ?? (ex && ex.console) ?? {};

  const kind = pick('kind', 'powershell') === 'exe' ? 'exe' : 'powershell';
  return {
    id: String(pick('id', '') || crypto.randomUUID()),
    name: String(pick('name', '')).trim(),
    kind,
    command: String(pick('command', '')),
    exePath: cleanPath(pick('exePath', '')),
    // exe 类型不再有「直接执行 / 默认程序」开关：生成脚本时一律交给系统默认程序（start ""）。
    // 旧配置里的 openWith 字段会被这里自然丢弃。
    arguments: String(pick('arguments', '')),
    workingDirectory: cleanPath(pick('workingDirectory', '')),
    env: normalizeEnv(pick('env', {})),
    trigger: {
      type: 'logon',
      delaySeconds: clampInt(trig.delaySeconds, 0, 600, DEFAULT_DELAY),
    },
    runLevel: pick('runLevel', 'limited') === 'highest' ? 'highest' : 'limited',
    enabled: pick('enabled', true) !== false,
    console: { visible: true, keepOpen: cons.keepOpen !== false },
    createdAt: ex ? ex.createdAt : now,
    updatedAt: now,
    applied: ex ? ex.applied : null,
    lastRun: ex ? ex.lastRun : null,
  };
}

/** 去掉首尾空白与误粘贴的成对引号（从资源管理器"复制路径"常带引号） */
function cleanPath(s) {
  let p = String(s || '').trim();
  if (p.length > 1) {
    const first = p[0];
    const last = p[p.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) p = p.slice(1, -1).trim();
  }
  return p;
}

/**
 * 生效的工作目录。
 * 留空时不再落到"本工具所在目录"（那是个隐蔽的坑），而是：
 *   - exe 类型：exe 所在目录（与在资源管理器里双击一致）
 *   - PowerShell 类型：当前用户目录（与新开一个 PowerShell 窗口一致）
 */
function effectiveWorkingDirectory(item) {
  if (item.workingDirectory) return item.workingDirectory;
  if (item.kind === 'exe' && item.exePath) {
    const dir = path.dirname(item.exePath);
    if (dir && dir !== '.' && path.isAbsolute(dir)) return dir;
  }
  return process.env.USERPROFILE || '';
}

/** 返回 { errors, warnings } */
function validate(item) {
  const errors = [];
  const warnings = [];
  if (!item.name) errors.push('名称不能为空');
  else if (item.name.length > 64) errors.push('名称不能超过 64 个字符');

  if (item.kind === 'exe') {
    if (!item.exePath) errors.push('请填写文件路径');
    else if (!path.isAbsolute(item.exePath)) errors.push('文件路径必须是绝对路径');
    else {
      // 统一交给系统默认程序（ShellExecute），所以不再限制扩展名。
      // 只有 .ps1 会被默认关联到记事本，几乎肯定不是用户想要的行为，给个警告。
      if (path.extname(item.exePath).toLowerCase() === '.ps1') {
        warnings.push('这是 PowerShell 脚本，系统默认程序通常会用记事本打开；建议改用「PowerShell 命令」类型');
      }
      if (!fs.existsSync(item.exePath)) warnings.push('文件不存在或当前用户无权访问：' + item.exePath);
    }
  } else if (!item.command.trim()) {
    errors.push('PowerShell 命令不能为空');
  }

  if (item.workingDirectory) {
    if (!path.isAbsolute(item.workingDirectory)) errors.push('工作目录必须是绝对路径');
    else if (!fs.existsSync(item.workingDirectory)) warnings.push('工作目录不存在：' + item.workingDirectory);
  }
  if (item.runLevel === 'highest') {
    warnings.push('“最高权限”项目在保存任务时需要管理员权限；登录时会以提权身份静默运行');
  }
  return { errors, warnings };
}

function normalizeDoc(doc) {
  const d = emptyDoc();
  if (doc && typeof doc.version === 'number') d.version = doc.version;
  if (doc && Array.isArray(doc.items)) {
    d.items = doc.items
      .filter((it) => it && typeof it === 'object' && it.id)
      .map((it) => normalizeItem(it, it));
  }
  return d;
}

function load() {
  if (state) return state;
  ensureDirs();
  let raw;
  try {
    raw = fs.readFileSync(files.config, 'utf8');
  } catch {
    state = emptyDoc();
    return state;
  }
  try {
    state = normalizeDoc(JSON.parse(raw));
  } catch (e) {
    const backup = `${files.config}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(files.config, backup);
    } catch {
      /* 忽略 */
    }
    log.error('配置文件损坏，已备份为', path.basename(backup), String(e.message));
    state = emptyDoc();
  }
  return state;
}

function save() {
  ensureDirs();
  const { writeFileRetry } = require('./fsutil');
  const doc = load();
  const text = JSON.stringify(doc, null, 2);
  const tmp = files.config + '.tmp';
  writeFileRetry(tmp, text);
  try {
    if (fs.existsSync(files.config)) fs.copyFileSync(files.config, files.config + '.bak');
  } catch {
    /* 备份失败不阻断 */
  }
  fs.renameSync(tmp, files.config);
}

function list() {
  return load().items;
}

function get(id) {
  return load().items.find((it) => it.id === id) || null;
}

function upsert(item) {
  const doc = load();
  const idx = doc.items.findIndex((it) => it.id === item.id);
  if (idx >= 0) doc.items[idx] = item;
  else doc.items.push(item);
  save();
  return item;
}

function remove(id) {
  const doc = load();
  const idx = doc.items.findIndex((it) => it.id === id);
  if (idx < 0) return null;
  const [gone] = doc.items.splice(idx, 1);
  save();
  return gone;
}

function markApplied(id, applied) {
  const it = get(id);
  if (!it) return;
  it.applied = applied;
  save();
}

function markRun(id, result) {
  const it = get(id);
  if (!it) return;
  it.lastRun = result;
  save();
}

function resetForTests() {
  state = null;
}

module.exports = {
  DEFAULT_DELAY,
  normalizeItem,
  validate,
  effectiveWorkingDirectory,
  load,
  save,
  list,
  get,
  upsert,
  remove,
  markApplied,
  markRun,
  resetForTests,
  files,
};
