# AGENTS.md

本文件是这个项目的「给后续开发者/Agent 的说明书」。改代码前请先读完，尤其是「硬约束」。

## 项目是什么

Windows 开机自启管理器：起一个只监听 `127.0.0.1` 的 HTTP 服务，用浏览器配置自启项；
登录 Windows 时由**计划任务**拉起，运行 PowerShell 命令或指定 exe，并**保留控制台窗口**。

零 npm 运行时依赖，只用 `node:` 内置模块；CommonJS 写到底。

## 目录

```
src/
  main.js      入口：参数解析、单实例、起服务、--run 宿主模式
  server.js    HTTP：token/Host/Origin/CSRF 校验、静态资源、路由分发
  api.js       业务接口：CRUD、启停、运行、脚本预览、卸载
  config.js    配置模型：normalize / validate / 原子写
  wrapper.js   生成 run.ps1 / run.cmd（用户命令落文件，不拼命令行）
  sched.js     计划任务：XML 构造、注册/注销/启停/查询、fake 模式
  runner.js    控制台宿主：跑 wrapper、汇总退出码、keepOpen、写 last-run.json
  paths.js     数据目录、SEA 判定、便携模式
  fsutil.js    写入重试（杀软/句柄瞬时占用）
  log.js       服务自身日志（logs/app.log，2MB 轮转）
  ui/          零构建前端（index.html / app.js / style.css），打包时内联
build/
  bundle.js    自研 CJS 打包器 → dist 前的单个 app.cjs（在 .build/ 里）
  build.js     发布构建：单文件优先，失败才出绿色包
test/
  smoke.js             端到端 API 测试（需 fake 调度器）
  real-task-test.ps1   真机验证：真注册任务 + 探测窗口可见性
```

## 硬约束（改了就会坏）

1. **不要引入 npm 运行时依赖**。SEA 单文件打包要求依赖可静态内联；一旦引入原生模块，整条打包链就废了。
   需要原生能力（计划任务）统一走 PowerShell 子进程。
2. **生成的 `.ps1` 必须带 UTF-8 BOM**。PowerShell 5.1 对无 BOM 文件按 ANSI(GBK) 解析，中文必乱码/语法错。
   `wrapper.js` 里 `bom: true` 就是这个原因；`test/*.ps1` 同理。
3. **用户命令只写进脚本文件，绝不拼进计划任务命令行**。这是绕开引号嵌套、长度限制、编码问题的唯一简单解。
4. **退出码只能由 `runner.js` 汇总**。`$LASTEXITCODE` 不反映 `exit N`，
   在 wrapper 里打印退出码会给出错误信息（这个坑踩过一次）。
5. **计划任务参数不能省**：`InteractiveToken`、`ExecutionTimeLimit=PT0S`、`Hidden=false`、
   `MultipleInstances=IgnoreNew`、`AllowStartIfOnBatteries`/不 `StopIfGoingOnBatteries`。
   少任何一个都会导致「窗口不出现」或「72 小时后被杀」。
6. **默认不提升权限**。本地 HTTP + 提权进程 = 最坏组合，只在「最高权限」项按需 UAC。
7. **写文件用 `fsutil.writeFileRetry`**。Windows 上杀软扫描会瞬时返回 EPERM/EBUSY。
8. **控制台输出必须真的接到控制台**。`spawn(..., { stdio: 'ignore' })` 或 detached 直启会把子进程
   stdout 换成 **NUL 设备** —— 窗口照样弹出、标题也正常，但内容全黑。
   统一用 `cmd /c start ""` 拉起（`api.spawnRunnerDetached`），runner 在 `!process.stdout.isTTY` 时
   会自动用 `start` 重启一次自己（`--relaunched` 防循环）。回归脚本：`node test/console-probe.js`。

## 常用命令

```bash
node src/main.js --dev              # 开发态服务（前端从 src/ui 读盘，改完刷新即可）
SM_PORT=18777 node src/main.js      # 指定端口（仅供调试；默认 8767，占用会自动换随机口）

# 端到端测试（另开一个终端；SM_NO_OPEN=1 阻止测试时弹浏览器）
SM_DATA_DIR=.sm-test SM_FAKE_TASKS=1 SM_TOKEN=tok SM_NO_OPEN=1 SM_PORT=18777 node src/main.js
SM_DATA_DIR=.sm-test SM_BASE=http://127.0.0.1:18777 node test/smoke.js

node build/build.js                 # 发布构建（dist 只留一个形态）
```

真机验证（会真的注册计划任务并弹窗，结束后自动清理）：

```powershell
powershell -ExecutionPolicy Bypass -File test/real-task-test.ps1 -Base http://127.0.0.1:18787 -Token xxx
```

## 环境陷阱（在 DSH / 沙箱里开发时）

- **工作区里那份 `node.exe` 拷贝无法注册计划任务**（返回「拒绝访问」）。这是沙箱对工作区可执行文件的限制，
  不是代码问题。测试注册流程请用系统 `D:\Program Files\nodejs\node.exe`，或直接用 `SM_FAKE_TASKS=1`。
- 后台作业进程可能拿不到 `%LOCALAPPDATA%` 的写权限，用 `--data-dir <工作区目录>` 绕开；
  注意便携模式下计划任务 Action 会自动带 `--data-dir`，否则宿主进程会去找默认目录。
- 含中文的 `.ps1` 没有 BOM 会直接语法错误；用 `[IO.File]::WriteAllText($p,$t,(New-Object Text.UTF8Encoding($true)))`。
- 构建前先关掉正在运行的 `dist\StartupManager.exe`，否则 `dist` 删不掉（脚本已带重试与提示）。

## 性能（别退回去）

- 调度器主路径必须是原生 **`schtasks.exe`**：注册 ~50ms、查询 ~40ms。
  早期全走 PowerShell，每次 2.6 秒（加载 ScheduledTasks 模块），一次保存串行三次 → 用户要等 8 秒。
  PowerShell 版本保留为兜底（`applyItemPs` / `listTasksPs` 等），不要删。
- 写操作的返回值里自带任务状态（`applyItem` 返回 `state`），**不要再额外查一次列表**。
- 前端保存后是「乐观更新 + 后台刷新」，不要改回 `await refresh()` 之后才渲染。
- 改动后跑 `node test/perf.js` 看各操作耗时，超过 300ms 就要怀疑退化了。

## 扩展指引

新增一个项目字段时，按这个顺序改，漏一处就会出现「界面能填但不生效」：

1. `config.normalizeItem`：读入与默认值
2. `config.validate`：校验/告警
3. `wrapper.js`：若影响脚本生成
4. `sched.js buildTaskXml`：若影响任务 XML
5. `ui/index.html` + `ui/app.js`：表单与 `collect()`
6. `test/smoke.js`：补一条断言

## 数据与状态

- 数据目录：`%LOCALAPPDATA%\StartupManager`（`--data-dir` / `SM_DATA_DIR` 可改）
- `config.json` 是唯一事实源；`config.json.bak` 是上一版
- `items/<id>/run.ps1|run.cmd` 是派生产物，会被覆盖，不要手改
- 计划任务统一在 `\StartupManager\<id>`，便于整体审计与卸载
- `server.json` 只记录运行中的端口与 token，正常退出会删除
