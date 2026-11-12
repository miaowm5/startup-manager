'use strict';

const $ = (sel, root = document) => root.querySelector(sel);

const state = {
  items: [],
  system: null,
  editingId: null,
};

/* ---------------- 基础 ---------------- */

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-SM-Request': '1' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    credentials: 'same-origin',
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* 非 JSON 响应 */
  }
  if (!res.ok) {
    const err = new Error(data.error || `请求失败（HTTP ${res.status}）`);
    err.data = data;
    throw err;
  }
  return data;
}

function toast(message, kind = '') {
  const box = $('#toasts');
  // dialog 在 top layer，z-index 再高也压不过；有弹窗时把 toast 容器挂进弹窗里
  const openDlg = document.querySelector('dialog[open]');
  const host = openDlg || document.body;
  if (box.parentElement !== host) host.appendChild(box);

  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = message;
  box.append(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .25s';
    setTimeout(() => el.remove(), 260);
  }, 3600);
}

/** 弹窗内的报错条（不会被 top layer 遮住） */
function dlgError(message) {
  const box = $('#dlg-error');
  if (!message) {
    box.hidden = true;
    box.textContent = '';
    return;
  }
  box.textContent = message;
  box.hidden = false;
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('zh-CN', { hour12: false });
}

function button(label, onClick, cls = 'sm') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn ghost ' + cls;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

/* ---------------- 渲染 ---------------- */

function renderSystem() {
  const s = state.system;
  if (!s) return;
  $('#sysline').textContent = `${s.user} · ${s.os.hostname} · ${s.os.name}`;

  const admin = $('#pill-admin');
  admin.textContent = s.isAdmin ? '管理员权限' : '普通权限';
  admin.className = 'pill ' + (s.isAdmin ? 'warn' : 'ok');

  const sched = $('#pill-sched');
  if (s.app.fakeScheduler) {
    sched.textContent = '模拟调度器（测试模式）';
    sched.className = 'pill warn';
  } else if (s.scheduler.ok) {
    sched.textContent = '计划任务可用';
    sched.className = 'pill ok';
  } else {
    sched.textContent = '计划任务不可用';
    sched.className = 'pill bad';
  }

  const banner = $('#banner');
  const notes = [];
  if (s.app.fakeScheduler) notes.push('当前为测试模式（SM_FAKE_TASKS=1），不会真正写入计划任务。');
  if (!s.scheduler.ok && s.scheduler.error) notes.push('计划任务接口不可用：' + s.scheduler.error);
  if (!s.isAdmin) notes.push('当前以普通权限运行：可以正常管理“普通权限”项目；“最高权限”项目保存时需要管理员身份。');
  if (notes.length) {
    banner.textContent = notes.join('\n');
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
}

function stateText(item) {
  if (!item.enabled) return '已停用';
  if (item.missing) return '目标失效';
  if (item.drift) return '待同步';
  if (item.task && item.task.state === 'Ready') return '已生效';
  if (item.task && item.task.state === 'Running') return '运行中';
  if (item.task && item.task.state === 'Queued') return '排队中';
  if (item.task && item.task.state === 'Disabled') return '任务已禁用';
  if (item.task && item.task.state) return item.task.state;
  return '状态未知';
}

function stateClass(item) {
  if (!item.enabled) return 'off';
  if (item.missing) return 'bad';
  if (item.drift) return 'warn';
  if (item.task && item.task.state === 'Ready') return 'ok';
  return 'warn';
}

function summary(item) {
  if (item.kind === 'exe') {
    return `"${item.exePath}"${item.arguments ? ' ' + item.arguments : ''}`;
  }
  return (item.command || '').trim() || '(空命令)';
}

function metaOf(item) {
  const parts = [];
  parts.push(`延迟 ${item.trigger.delaySeconds}s`);
  parts.push(item.runLevel === 'highest' ? '最高权限' : '普通权限');
  if (item.console.keepOpen) parts.push('结束后保留窗口');
  const lr = item.lastRun;
  if (lr && lr.at) {
    parts.push(`上次 ${fmtTime(lr.at)} · 退出码 ${lr.exitCode}`);
  } else {
    parts.push('尚未运行');
  }
  return parts;
}

function card(item) {
  const el = document.createElement('article');
  el.className = 'card' + (item.enabled ? '' : ' off');
  el.dataset.id = item.id;

  const main = document.createElement('div');
  main.className = 'card-main';

  const row1 = document.createElement('div');
  row1.className = 'row1';
  const badge = document.createElement('span');
  badge.className = 'badge ' + (item.kind === 'exe' ? 'exe' : 'ps');
  badge.textContent = item.kind === 'exe' ? 'EXE' : 'PowerShell';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = item.name || '(未命名)';
  const st = document.createElement('span');
  st.className = 'state ' + stateClass(item);
  st.textContent = stateText(item);
  row1.append(badge, name, st);

  const cmd = document.createElement('pre');
  cmd.className = 'cmd';
  cmd.textContent = summary(item);
  cmd.title = '点击展开/收起';
  cmd.addEventListener('click', () => el.classList.toggle('expanded'));

  const meta = document.createElement('div');
  meta.className = 'meta';
  const parts = metaOf(item);
  parts.forEach((p, i) => {
    if (i) {
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.textContent = '·';
      meta.append(dot);
    }
    const sp = document.createElement('span');
    sp.textContent = p;
    meta.append(sp);
  });

  main.append(row1, cmd, meta);

  if (item.missing) {
    const miss = document.createElement('div');
    miss.className = 'drift';
    miss.textContent = '⚠ ' + item.missing + '（登录后任务仍会触发并失败，请修正路径或删除该项目）';
    main.append(miss);
  }

  if (item.drift) {
    const drift = document.createElement('div');
    drift.className = 'drift';
    drift.textContent = '⚠ ' + item.drift + '（点“重新同步”或重新保存即可修复）';
    main.append(drift);
  }

  const side = document.createElement('div');
  side.className = 'card-side';

  const sw = document.createElement('label');
  sw.className = 'switch';
  sw.title = item.enabled ? '停用' : '启用';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = !!item.enabled;
  cb.addEventListener('change', () => toggleItem(item, cb));
  const slider = document.createElement('span');
  sw.append(cb, slider);

  const btns = document.createElement('div');
  btns.className = 'btns';
  const runBtn = button('直接运行', () => runItem(item));
  runBtn.title = '立即执行一次（与登录自启使用同一套脚本），会打开独立控制台窗口';
  btns.append(
    runBtn,
    button('编辑', () => openEditor(item)),
    button('删除', () => deleteItem(item), 'danger')
  );

  side.append(sw, btns);
  el.append(main, side);
  return el;
}

function renderList() {
  const list = $('#list');
  list.textContent = '';
  const items = state.items || [];
  $('#empty').hidden = items.length > 0;
  for (const item of items) list.append(card(item));

  // 有失效项时才出现「清理失效项」按钮
  const missing = items.filter((it) => it.missing);
  const btn = $('#btn-cleanup');
  btn.hidden = missing.length === 0;
  btn.textContent = `清理失效项 (${missing.length})`;

  // 只有真的存在漂移（任务被删/被禁用、模板或程序路径变化）才显示「重新同步」
  const drifted = items.filter((it) => it.drift);
  const resyncBtn = $('#btn-resync');
  resyncBtn.hidden = drifted.length === 0;
  resyncBtn.textContent = `重新同步 (${drifted.length})`;
}

async function refresh() {
  if (state.uninstalled) return;
  // 两个请求并行；谁先回来先渲染，避免"系统信息慢"拖住列表
  const [sys, items] = await Promise.allSettled([api('/api/system'), api('/api/items')]);
  if (sys.status === 'fulfilled') {
    state.system = sys.value;
    renderSystem();
  }
  if (items.status === 'fulfilled') {
    state.items = items.value.items || [];
    renderList();
  }
  if (sys.status === 'rejected' && items.status === 'rejected') throw sys.reason;
}

/** 局部替换一条，避免整页等待刷新 */
function upsertLocal(item) {
  if (!item) return;
  const idx = state.items.findIndex((it) => it.id === item.id);
  if (idx >= 0) state.items[idx] = item;
  else state.items.push(item);
  renderList();
}

/* ---------------- 操作 ---------------- */

async function toggleItem(item, checkbox) {
  const action = checkbox.checked ? 'enable' : 'disable';
  // 先落一次本地状态，点下去立刻有反馈
  item.enabled = checkbox.checked;
  try {
    const res = await api(`/api/items/${item.id}/${action}`, { method: 'POST', body: {} });
    if (res.item) upsertLocal(res.item);
    toast(checkbox.checked ? '已启用' : '已停用', 'ok');
  } catch (e) {
    item.enabled = !checkbox.checked;
    checkbox.checked = !checkbox.checked;
    toast(e.message, 'err');
  }
  refresh().catch(() => {});
}

async function runItem(item) {
  try {
    await api(`/api/items/${item.id}/run`, { method: 'POST', body: {} });
    toast('已直接运行，请查看弹出的控制台窗口（关闭窗口即结束该任务）', 'ok');
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function deleteItem(item) {
  const ok = window.confirm(`确定删除「${item.name}」？\n将同时移除对应的计划任务与生成的脚本（日志保留）。`);
  if (!ok) return;
  try {
    await api(`/api/items/${item.id}`, { method: 'DELETE' });
    toast('已删除', 'ok');
    await refresh();
  } catch (e) {
    toast(e.message, 'err');
  }
}

/* ---------------- 编辑器 ---------------- */

function kindOf() {
  return document.querySelector('input[name="kind"]:checked').value;
}

function syncKindGroups() {
  const kind = kindOf();
  $('#grp-ps').hidden = kind !== 'powershell';
  $('#grp-exe').hidden = kind !== 'exe';
}

function openEditor(item) {
  state.editingId = item ? item.id : null;
  $('#dlg-title').textContent = item ? '编辑自启项' : '新建自启项';
  $('#preview').hidden = true;
  $('#preview').textContent = '';
  dlgError(null);

  const data = item || {
    name: '',
    kind: 'powershell',
    command: '',
    exePath: '',
    arguments: '',
    trigger: { delaySeconds: 20 },
    runLevel: 'limited',
    console: { keepOpen: true },
    enabled: true,
  };

  $('#f-name').value = data.name || '';
  document.querySelector(`input[name="kind"][value="${data.kind || 'powershell'}"]`).checked = true;
  $('#f-command').value = data.command || '';
  $('#f-exe').value = data.exePath || '';
  $('#f-args').value = data.arguments || '';
  $('#f-openwith').checked = data.openWith === 'default';
  $('#f-delay').value = data.trigger ? data.trigger.delaySeconds : 20;
  $('#f-level').value = data.runLevel || 'limited';
  $('#f-keep').checked = !data.console || data.console.keepOpen !== false;
  $('#f-enabled').checked = data.enabled !== false;

  syncKindGroups();
  $('#dlg-editor').showModal();
  setTimeout(() => $('#f-name').focus(), 30);
}

function collect() {
  return {
    name: $('#f-name').value.trim(),
    kind: kindOf(),
    command: $('#f-command').value,
    exePath: $('#f-exe').value.trim(),
    arguments: $('#f-args').value,
    openWith: $('#f-openwith').checked ? 'default' : 'direct',
    trigger: { delaySeconds: Math.max(0, Math.min(600, Number($('#f-delay').value) || 0)) },
    runLevel: $('#f-level').value,
    console: { keepOpen: $('#f-keep').checked },
    enabled: $('#f-enabled').checked,
  };
}

async function saveItem() {
  const draft = collect();
  const btn = $('#btn-save');
  btn.disabled = true;
  btn.textContent = '保存中…';
  dlgError(null);
  const startedAt = Date.now();
  try {
    const res = state.editingId
      ? await api(`/api/items/${state.editingId}`, { method: 'PUT', body: draft })
      : await api('/api/items', { method: 'POST', body: draft });
    // 乐观更新：拿返回的对象直接渲染，不等后续刷新
    upsertLocal(res.item);
    $('#dlg-editor').close();
    const ms = Date.now() - startedAt;
    if (res.taskError) {
      toast('项目已保存，但计划任务注册失败：' + res.taskError, 'err');
    } else if (res.warnings && res.warnings.length) {
      // 有警告时只提示警告，避免"已保存"+警告两条同时弹
      toast(res.warnings.join('；'), 'warn');
    } else {
      toast(`已保存并生效（${ms} ms）`, 'ok');
    }
    refresh().catch(() => {});
  } catch (e) {
    const list = e.data && Array.isArray(e.data.errors) ? e.data.errors : null;
    const text = list && list.length ? `${e.message}：\n· ${list.join('\n· ')}` : e.message;
    dlgError(text);
    toast(e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '保存并生效';
  }
}

async function previewScript() {
  try {
    const res = await api('/api/preview', { method: 'POST', body: collect() });
    const pre = $('#preview');
    pre.textContent = res.content || '(空)';
    pre.hidden = false;
    if (res.errors && res.errors.length) toast(res.errors.join('；'), 'err');
  } catch (e) {
    toast(e.message, 'err');
  }
}

/* ---------------- 查看对话框 ---------------- */

function openView(title) {
  $('#view-title').textContent = title;
  $('#dlg-view').showModal();
}

async function showScript(item) {
  try {
    const res = await api(`/api/items/${item.id}/script`);
    $('#view-pre').textContent = res.content || '(空)';
    openView(`${item.name} · 实际执行的脚本`);
  } catch (e) {
    toast(e.message, 'err');
  }
}

/* ---------------- 卸载 ---------------- */

function openUninstall() {
  $('#uninstall-count').textContent = String((state.items || []).length);
  $('#uninstall-confirm').value = '';
  $('#uninstall-msg').hidden = true;
  $('#btn-uninstall-do').disabled = true;
  $('#btn-uninstall-do').textContent = '确认卸载';
  $('#uninstall-main').hidden = false;
  $('#uninstall-done').hidden = true;
  $('#dlg-uninstall .dlg-foot').hidden = false;
  $('#dlg-uninstall').showModal();
  setTimeout(() => $('#uninstall-confirm').focus(), 30);
}

async function doUninstall() {
  if ($('#uninstall-confirm').value.trim() !== '卸载') return;
  const btn = $('#btn-uninstall-do');
  btn.disabled = true;
  btn.textContent = '清理中…';
  try {
    const res = await api('/api/uninstall', { method: 'POST', body: { confirm: 'UNINSTALL' } });
    state.uninstalled = true;
    state.items = [];
    $('#uninstall-main').hidden = true;
    $('#uninstall-done').hidden = false;
    $('#dlg-uninstall .dlg-foot').hidden = true;
    toast(`已注销 ${res.removedTasks} 个任务，数据目录已清理`, 'ok');
  } catch (e) {
    const box = $('#uninstall-msg');
    box.textContent = e.message;
    box.hidden = false;
    btn.disabled = false;
    btn.textContent = '确认卸载';
  }
}

/* ---------------- 绑定 ---------------- */

function bind() {
  $('#btn-new').addEventListener('click', () => openEditor(null));
  $('#btn-new-2').addEventListener('click', () => openEditor(null));

  document.querySelectorAll('[data-close]').forEach((el) => {
    el.addEventListener('click', () => el.closest('dialog').close());
  });

  // 弹窗关闭后把 toast 容器放回 body，避免它被关掉的弹窗带走
  document.querySelectorAll('dialog').forEach((dlg) => {
    dlg.addEventListener('close', () => {
      if (!document.querySelector('dialog[open]')) document.body.appendChild($('#toasts'));
    });
  });

  document.querySelectorAll('input[name="kind"]').forEach((el) => el.addEventListener('change', syncKindGroups));

  $('#btn-save').addEventListener('click', saveItem);
  $('#btn-preview').addEventListener('click', previewScript);

  $('#btn-resync').addEventListener('click', async () => {
    try {
      const res = await api('/api/tasks/resync', { method: 'POST', body: {} });
      const failed = (res.results || []).filter((r) => !r.ok);
      if (failed.length) toast(`同步完成，${failed.length} 个失败：${failed[0].error || ''}`, 'err');
      else toast('已重新同步全部计划任务', 'ok');
      await refresh();
    } catch (e) {
      toast(e.message, 'err');
    }
  });

  $('#btn-cleanup').addEventListener('click', async () => {
    const missing = (state.items || []).filter((it) => it.missing);
    if (!missing.length) return;
    const names = missing.map((it) => '· ' + it.name + '  →  ' + it.exePath).join('\n');
    const ok = window.confirm(
      `将删除以下 ${missing.length} 个失效项，同时移除它们对应的计划任务与配置：\n\n${names}\n\n日志文件会保留。继续？`
    );
    if (!ok) return;
    try {
      const res = await api('/api/tasks/cleanup-missing', { method: 'POST', body: {} });
      toast(`已清理 ${res.removed.length} 个失效项`, 'ok');
      await refresh();
    } catch (e) {
      toast(e.message, 'err');
    }
  });

  $('#btn-uninstall').addEventListener('click', openUninstall);
  $('#uninstall-confirm').addEventListener('input', (ev) => {
    $('#btn-uninstall-do').disabled = ev.target.value.trim() !== '卸载';
  });
  $('#btn-uninstall-do').addEventListener('click', doUninstall);

  document.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter' && $('#dlg-editor').open) saveItem();
  });
}

bind();
refresh().catch((e) => toast('加载失败：' + e.message, 'err'));
