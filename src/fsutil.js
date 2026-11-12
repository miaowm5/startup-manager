'use strict';
/**
 * 文件写入加固：Windows 上杀软扫描、进程退出瞬间释放句柄，都会让刚创建的文件短暂
 * 返回 EPERM/EBUSY。这里做有限重试，避免"偶发一次就整个功能失败"。
 */
const fs = require('fs');

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* 忽略 */
  }
}

function writeFileRetry(file, data, tries = 6) {
  let lastErr;
  for (let i = 0; i < tries; i += 1) {
    try {
      fs.writeFileSync(file, data, 'utf8');
      return true;
    } catch (e) {
      lastErr = e;
      if (!RETRY_CODES.has(e.code) || i === tries - 1) throw e;
      sleepSync(80 * (i + 1));
    }
  }
  throw lastErr;
}

function mkdirRetry(dir, tries = 6) {
  for (let i = 0; i < tries; i += 1) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      return true;
    } catch (e) {
      if (!RETRY_CODES.has(e.code) || i === tries - 1) throw e;
      sleepSync(80 * (i + 1));
    }
  }
  return false;
}

module.exports = { writeFileRetry, mkdirRetry, sleepSync };
