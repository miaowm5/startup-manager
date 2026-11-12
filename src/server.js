'use strict';
/**
 * 本地 HTTP 服务。安全基线：
 *  - 只绑 127.0.0.1
 *  - 启动生成随机 token（URL 带入 → 换 Cookie，随后从 URL 抹掉）
 *  - 校验 Host（防 DNS rebinding）与 Origin
 *  - 变更请求要求自定义头 X-SM-Request（不开 CORS，跨站无法伪造）
 */
const http = require('http');
const crypto = require('crypto');
const api = require('./api');
const ui = require('./ui');
const log = require('./log');

const COOKIE = 'sm_auth';
const MAX_BODY = 1024 * 1024;

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length === 0 || ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function parseCookies(header) {
  const out = {};
  String(header || '')
    .split(';')
    .forEach((part) => {
      const i = part.indexOf('=');
      if (i < 0) return;
      try {
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        /* 忽略坏 Cookie */
      }
    });
  return out;
}

function loopbackName(name) {
  return name === '127.0.0.1' || name === 'localhost' || name === '::1' || name === '[::1]';
}

function hostNameOf(req) {
  const h = String(req.headers.host || '').toLowerCase();
  if (!h) return '';
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.split(':')[0];
}

function sendJson(res, status, obj, headers) {
  const text = JSON.stringify(obj);
  res.writeHead(status, {
    ...(headers || {}),
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function sendText(res, status, text, headers) {
  res.writeHead(status, {
    ...(headers || {}),
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function sendAsset(res, name, type, headers) {
  const body = ui.getAsset(name);
  if (body == null) return sendText(res, 404, '资源缺失：' + name, headers);
  res.writeHead(200, { ...(headers || {}), 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('JSON 解析失败'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'none'; base-uri 'none'",
};

async function handle(req, res, ctx) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const headers = SEC_HEADERS;

  const hostName = hostNameOf(req);
  if (hostName && !loopbackName(hostName)) return sendText(res, 421, 'Misdirected Request', headers);

  if (req.headers.origin) {
    let originOk = false;
    try {
      const o = new URL(req.headers.origin);
      originOk = loopbackName(o.hostname) && String(o.port || '80') === String(ctx.port);
    } catch {
      originOk = false;
    }
    if (!originOk) return sendJson(res, 403, { error: '非法来源' }, headers);
  }

  const cookies = parseCookies(req.headers.cookie);
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const queryToken = url.searchParams.get('t');

  let authed = safeEqual(cookies[COOKIE], ctx.token) || safeEqual(bearer, ctx.token);
  let viaQuery = false;
  if (!authed && queryToken && safeEqual(queryToken, ctx.token)) {
    authed = true;
    viaQuery = true;
  }

  if (!authed) {
    return sendText(res, 401, '未授权：请使用启动时打印的带 token 的地址访问本界面。', headers);
  }

  if (viaQuery) {
    url.searchParams.delete('t');
    const qs = url.searchParams.toString();
    res.writeHead(302, {
      ...headers,
      'Set-Cookie': `${COOKIE}=${encodeURIComponent(ctx.token)}; Path=/; HttpOnly; SameSite=Strict`,
      Location: url.pathname + (qs ? '?' + qs : ''),
    });
    return res.end();
  }

  const method = String(req.method || 'GET').toUpperCase();
  const mutating = method !== 'GET' && method !== 'HEAD';
  if (mutating && req.headers['x-sm-request'] !== '1') {
    return sendJson(res, 403, { error: '缺少 X-SM-Request 头' }, headers);
  }

  if (url.pathname.startsWith('/api/')) {
    let body;
    try {
      body = mutating ? await readBody(req) : Object.fromEntries(url.searchParams);
    } catch (e) {
      return sendJson(res, e.status || 400, { error: e.message }, headers);
    }
    const result = api.dispatch(method, url.pathname, body);
    if (!result) return sendJson(res, 404, { error: '接口不存在' }, headers);
    return sendJson(res, result.status, result.json, headers);
  }

  if (url.pathname === '/' || url.pathname === '/index.html')
    return sendAsset(res, 'index.html', 'text/html; charset=utf-8', headers);
  if (url.pathname === '/app.js')
    return sendAsset(res, 'app.js', 'application/javascript; charset=utf-8', headers);
  if (url.pathname === '/style.css')
    return sendAsset(res, 'style.css', 'text/css; charset=utf-8', headers);
  if (url.pathname === '/favicon.ico') {
    res.writeHead(204, headers);
    return res.end();
  }
  return sendText(res, 404, 'Not Found', headers);
}

function createServer(ctx) {
  return http.createServer((req, res) => {
    handle(req, res, ctx).catch((err) => {
      log.error('请求处理异常', methodOf(req), req.url, err && err.message);
      if (!res.headersSent) sendJson(res, 500, { error: '服务器内部错误' });
      else res.end();
    });
  });
}

function methodOf(req) {
  return String(req.method || 'GET');
}

module.exports = { createServer };
