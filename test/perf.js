const sched = require('../src/sched');
function t(label, fn) { const s = Date.now(); const r = fn(); console.log(label.padEnd(26), (Date.now()-s)+'ms'); return r; }
const item = { id:'perf-0001', name:'perf', kind:'powershell', enabled:true, runLevel:'limited',
  trigger:{delaySeconds:0}, console:{keepOpen:false}, logging:{} };
t('probe()', () => sched.probe());
t('applyItem()  注册', () => sched.applyItem(item));
t('listTasks()  第一次', () => sched.listTasks());
t('listTasks()  第二次', () => sched.listTasks());
t('setEnabled()', () => sched.setEnabled(item.id, false));
t('removeItem()', () => sched.removeItem(item.id));
