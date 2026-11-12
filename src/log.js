'use strict';
const fs = require('fs');
const { files, ensureDirs } = require('./paths');

const MAX_BYTES = 2 * 1024 * 1024;

function rotateIfNeeded() {
  try {
    const st = fs.statSync(files.appLog);
    if (st.size > MAX_BYTES) fs.renameSync(files.appLog, files.appLog + '.1');
  } catch {
    /* 文件不存在，忽略 */
  }
}

function write(level, args) {
  const line = `[${new Date().toISOString()}] ${level} ${args
    .map((a) => (typeof a === 'string' ? a : safeStringify(a)))
    .join(' ')}`;
  if (level === 'ERROR') console.error(line);
  else console.log(line);
  appendToFile(line);
}

/** 只落盘不打印：给控制台宿主（runner）用，避免污染用户看到的输出 */
function toFile(level, args) {
  const line = `[${new Date().toISOString()}] ${level} ${args
    .map((a) => (typeof a === 'string' ? a : safeStringify(a)))
    .join(' ')}`;
  appendToFile(line);
}

function appendToFile(line) {
  try {
    ensureDirs();
    rotateIfNeeded();
    fs.appendFileSync(files.appLog, line + '\r\n', 'utf8');
  } catch {
    /* 落盘失败不影响主流程 */
  }
}

function safeStringify(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

module.exports = {
  info: (...a) => write('INFO ', a),
  warn: (...a) => write('WARN ', a),
  error: (...a) => write('ERROR', a),
  toFile: (level, ...a) => toFile(String(level).padEnd(5), a),
};
