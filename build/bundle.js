'use strict';
/**
 * 极简 CJS 打包器：把 src/*.js 与前端资源打成一个 app.cjs。
 * 之所以不用 esbuild/webpack：本项目零依赖，打包链路越短越不容易坏，SEA 也只需要一个入口文件。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const pkg = require(path.join(ROOT, 'package.json'));

const MODULES = ['fsutil', 'textcodec', 'paths', 'log', 'config', 'wrapper', 'sched', 'runner', 'ui', 'api', 'server', 'main'];

function read(p) {
  return fs.readFileSync(path.join(ROOT, p), 'utf8');
}

function rewriteLocalRequires(code) {
  return (
    code
      // 只处理 ./xxx 与文字 ../package.json，其余（node: 内置模块）原样保留
      .replace(/require\(\s*['"]\.\/([\w.-]+?)(?:\.js)?['"]\s*\)/g, "__req('$1')")
      .replace(/require\(\s*['"]\.\.\/package\.json['"]\s*\)/g, JSON.stringify({ version: pkg.version }))
  );
}

function buildUi() {
  const uiMap = {};
  for (const name of ['index.html', 'app.js', 'style.css']) {
    uiMap[name] = read(path.join('src', 'ui', name));
  }
  return uiMap;
}

function build(version) {
  const ui = buildUi();
  const parts = [];

  parts.push("'use strict';");
  parts.push('/* StartupManager 打包产物（自动生成，勿手改） */');
  parts.push('const __defs = Object.create(null);');
  parts.push('const __cache = Object.create(null);');
  parts.push('function __req(id) {');
  parts.push('  if (__cache[id]) return __cache[id].exports;');
  parts.push('  const module = { exports: {} };');
  parts.push('  __cache[id] = module;');
  parts.push('  if (!__defs[id]) throw new Error("模块缺失: " + id);');
  parts.push('  __defs[id].call(module.exports, module, module.exports, require);');
  parts.push('  return module.exports;');
  parts.push('}');
  parts.push('global.__SM_UI__ = ' + JSON.stringify(ui) + ';');
  parts.push('global.__SM_BUNDLED__ = true;');
  parts.push('');

  for (const name of MODULES) {
    const file = path.join(SRC, name + '.js');
    if (!fs.existsSync(file)) throw new Error('缺少源文件：' + file);
    const code = rewriteLocalRequires(fs.readFileSync(file, 'utf8'));
    if (code.includes('__SM_VERSION__')) {
      // 预留占位符替换（当前未使用）
    }
    parts.push(`__defs[${JSON.stringify(name)}] = function (module, exports, require) {`);
    parts.push(code.trimEnd());
    parts.push('};');
    parts.push('');
  }

  parts.push("__req('main');");
  parts.push('');
  return parts.join('\n');
}

module.exports = { build, MODULES };

if (require.main === module) {
  const out = path.join(ROOT, 'dist', 'app.cjs');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, build(pkg.version), 'utf8');
  console.log('已生成 ' + out + '（' + (fs.statSync(out).size / 1024).toFixed(1) + ' KB）');
}
