'use strict';
/**
 * Windows 控制台输出解码。
 *
 * 坑：schtasks.exe / powershell.exe 通过管道输出时，用的是**控制台代码页**（简中系统 = 936/GBK），
 * 不是 UTF-8。直接 toString('utf8') 会把「就绪」变成 4 个 U+FFFD，界面显示成方块（乱码）。
 *
 * 处理：先查 chcp 拿到代码页 → 用对应解码器；解码结果若出现替换字符，再按中文系编码兜底。
 */
const { spawnSync } = require('child_process');

const CP_LABELS = {
  65001: 'utf-8',
  936: 'gbk',
  54936: 'gb18030',
  950: 'big5',
  932: 'shift_jis',
  949: 'euc-kr',
  1250: 'windows-1250',
  1251: 'windows-1251',
  1252: 'windows-1252',
  1253: 'windows-1253',
  1254: 'windows-1254',
  1255: 'windows-1255',
  1256: 'windows-1256',
  1257: 'windows-1257',
  1258: 'windows-1258',
  866: 'ibm866',
};

let cachedCp = 0;

function consoleCodePage() {
  if (cachedCp) return cachedCp;
  try {
    const r = spawnSync('chcp.com', [], { encoding: 'latin1', windowsHide: true, timeout: 5000 });
    const m = /(\d{3,5})/.exec(r.stdout || '');
    cachedCp = m ? Number.parseInt(m[1], 10) : 65001;
  } catch {
    cachedCp = 65001;
  }
  return cachedCp;
}

function decodeWith(label, buf) {
  try {
    const s = new TextDecoder(label, { fatal: false }).decode(buf);
    return s.includes('\uFFFD') ? null : s;
  } catch {
    return null;
  }
}

/** 解码一段来自控制台程序的原始输出 */
function decodeConsole(buf) {
  if (!buf || !buf.length) return '';
  const buffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);

  const label = CP_LABELS[consoleCodePage()];
  if (label) {
    const s = decodeWith(label, buffer);
    if (s !== null) return s;
  }

  // 代码页判断失败或与实际不符时的兜底
  for (const enc of ['utf-8', 'gbk', 'gb18030', 'big5', 'shift_jis', 'euc-kr']) {
    const s = decodeWith(enc, buffer);
    if (s !== null) return s;
  }
  return buffer.toString('utf8');
}

/** 把 schtasks / 计划任务返回的状态归一化成稳定的英文枚举，避免界面显示成英文/本地化混杂 */
function normalizeState(raw) {
  const s = String(raw || '').trim();
  if (!s) return 'Unknown';
  if (/(disabled|已禁用|禁用|無効|使用不可)/i.test(s)) return 'Disabled';
  if (/(running|正在运行|运行中|実行中|正在執行)/i.test(s)) return 'Running';
  if (/(queued|已排队|排队|キュー)/i.test(s)) return 'Queued';
  if (/(ready|就绪|已就绪|準備完了|准备)/i.test(s)) return 'Ready';
  if (/(unknown|未知|不明)/i.test(s)) return 'Unknown';
  return s;
}

module.exports = { decodeConsole, consoleCodePage, normalizeState };
