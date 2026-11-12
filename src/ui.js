'use strict';
/**
 * 前端资源加载：开发态从磁盘读，打包态（SEA）从 build 时内联的 global.__SM_UI__ 读。
 * 这样 SEA 不依赖 assets API，也避免打包后路径问题。
 */
const fs = require('fs');
const path = require('path');

const FILES = ['index.html', 'app.js', 'style.css'];

function getAsset(name) {
  const key = String(name).replace(/^\/+/, '');
  if (!FILES.includes(key)) return null;
  const inline = global.__SM_UI__;
  if (inline && typeof inline[key] === 'string') return inline[key];
  try {
    return fs.readFileSync(path.join(__dirname, 'ui', key), 'utf8');
  } catch {
    return null;
  }
}

module.exports = { getAsset, FILES };
