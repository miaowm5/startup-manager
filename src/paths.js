'use strict';
/**
 * 路径与运行形态解析。
 * - 数据目录：%LOCALAPPDATA%\StartupManager（可用 SM_DATA_DIR 覆盖，便于测试与绿色迁移）
 * - SEA 形态：单文件 exe 内运行，缺少可写的脚本目录，所有派生产物都落在数据目录
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

function isSea() {
  try {
    return require('node:sea').isSea();
  } catch {
    return false;
  }
}

const SEA = isSea();

const DEFAULT_ROOT = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'StartupManager'
);

const ROOT = process.env.SM_DATA_DIR ? path.resolve(process.env.SM_DATA_DIR) : DEFAULT_ROOT;

/** 数据目录是否被显式改到别处（便携模式）。计划任务的 Action 需要带上 --data-dir 才能找到配置 */
const PORTABLE = path.resolve(ROOT) !== path.resolve(DEFAULT_ROOT);

const dirs = {
  root: ROOT,
  items: path.join(ROOT, 'items'),
  logs: path.join(ROOT, 'logs'),
};

const files = {
  config: path.join(ROOT, 'config.json'),
  server: path.join(ROOT, 'server.json'),
  lock: path.join(ROOT, 'server.lock'),
  appLog: path.join(ROOT, 'logs', 'app.log'),
};

function ensureDirs() {
  const { mkdirRetry } = require('./fsutil');
  for (const d of Object.values(dirs)) mkdirRetry(d);
  return dirs;
}

/** 项目派生产物目录（脚本、转录日志），id 做文件名安全化 */
function itemDir(id) {
  return path.join(dirs.items, String(id).replace(/[^\w.-]/g, '_'));
}

module.exports = { SEA, ROOT, DEFAULT_ROOT, PORTABLE, dirs, files, ensureDirs, itemDir, isSea };
