// 端口管家 · 前端逻辑（端口列表 / 停止记录 / 详情弹层）
const $ = s => document.querySelector(s);
let ME = '', PLATFORM = '';
let ports = [], stoplog = [], aliases = {};
const titles = {};        // port -> 探测缓存
let keyword = '', view = 'ports', timer = null;

async function api(url, opt) {
  const r = await fetch(url, opt);
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw new Error(d.error || r.status);
  return d;
}
function esc(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function cmdTail(c, n = 52) {
  const s = String(c || '');
  return s.length <= n ? s : '…' + s.slice(-n);
}
function fmtTime(ts) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ============ 数据加载 ============
async function load() {
  $('#refresh').disabled = true;
  try {
    const d = await api('/api/ports');
    ME = d.me; PLATFORM = d.platform;
    ports = d.ports;
    $('#plat').textContent = PLATFORM;
    $('#platTip').textContent = PLATFORM === 'win32' ? 'Windows 模式（netstat）' : PLATFORM === 'darwin' ? 'macOS 模式（lsof）' : PLATFORM;
    renderPorts();
    probeAll();
  } catch (e) { $('#rows').innerHTML = `<div class="empty">读取失败：${esc(e.message)}</div>`; }
  $('#refresh').disabled = false;
}

async function loadLog() {
  try {
    stoplog = (await api('/api/stoplog')).log;
    $('#logBadge').textContent = stoplog.length;
    renderLog();
  } catch (e) { $('#logRows').innerHTML = `<div class="empty">读取失败：${esc(e.message)}</div>`; }
}

async function loadAliases() {
  try { aliases = (await api('/api/aliases')).aliases || {}; } catch { aliases = {}; }
  renderPorts();
}

async function probeAll() {
  const targets = ports.filter(p => p.kind !== 'dynamic' && titles[p.port] === undefined);
  await Promise.all(targets.map(async p => {
    try { titles[p.port] = await api('/api/probe?port=' + p.port); }
    catch { titles[p.port] = { http: false }; }
  }));
  renderPorts();
}

// ============ 渲染 ============
function match(text) {
  if (!keyword) return true;
  return String(text || '').toLowerCase().includes(keyword);
}

function renderPorts() {
  const hits = ports.filter(p =>
    match(p.port) || (titles[p.port] && match(titles[p.port].title)) || p.procs.some(x => match(x.command) || match(x.cwd)));
  $('#portBadge').textContent = ports.length;
  const rowsEl = $('#rows');
  if (!hits.length) { rowsEl.innerHTML = '<div class="empty">没有匹配的端口</div>'; return; }

  rowsEl.innerHTML = hits.map(p => {
    const proc = p.procs[0];
    const t = titles[p.port];
    const isTool = p.procs.some(x => String(x.command).includes('portctl'));
    const badges = [
      p.known ? `<span class="tag sys">${esc(p.known)}</span>` : (p.kind === 'dynamic' ? '<span class="tag sys">系统动态</span>' : ''),
      p.mine ? '<span class="tag me">我的</span>' : `<span class="tag sys">${esc(proc.user)}</span>`,
      isTool ? '<span class="tag me">本工具</span>' : '',
    ].join(' ');
    const res = p.procs.map(x =>
      `<div class="res">CPU ${x.cpu == null ? '—' : x.cpu + '%'} · 内存 ${x.rssMB == null ? '—' : x.rssMB + 'MB'}</div>`).join('');
    const alias = aliases[p.port];
    const http = alias
      ? `<div class="http" data-aliasedit="${p.port}" title="点击改名字 / 清除恢复自动识别"><div class="t">${esc(alias)} <span style="color:var(--dim);font-size:10px">✎</span></div><div class="s">自定义命名${t && t.http ? ' · 原识别: ' + esc(t.title || 'HTTP ' + t.status) : ''}</div></div>`
      : (t
        ? (t.http
          ? `<div class="http" data-aliasedit="${p.port}" title="点击自定义命名"><div class="t">${esc(t.title || '(HTTP，无标题)')} <span style="color:var(--dim);font-size:10px">✎</span></div><div class="s">HTTP ${t.status}${t.server ? ' · ' + esc(t.server) : ''}</div></div>`
          : '<div class="http none">非 HTTP 服务</div>')
        : '<div class="http none">探测中…</div>');
    const canStop = p.mine && p.port !== 9123;
    const action = canStop
      ? `<button class="btn danger" data-stop="${p.port}">停止</button>`
      : (p.port === 9123 ? '<span class="tag me">就是本页</span>' : '<button class="btn" disabled title="系统服务或他人进程">🔒</button>');
    return `
    <div class="row compact" data-port="${p.port}">
      <div class="port">${p.port}<small>${esc(p.addrs[0])}</small>${badges}</div>
      <div class="clickable" data-detail="${proc.pid}" title="点击查看完整路径">
        <div class="pname">${esc(cmdTail(proc.command.split(' ')[0], 34))} <span style="color:var(--dim);font-weight:400;font-size:11px">· ${proc.pid}</span></div>
        <div class="pcmd">${esc(cmdTail(proc.command))}</div>
      </div>
      <div>${res}</div>
      <div>${http}</div>
      <div>${action}</div>
    </div>`;
  }).join('');
}

function renderLog() {
  const hits = stoplog.filter(x => match(x.port) || match(x.command) || match(x.cwd) || match(x.ts && fmtTime(x.ts)) || match(nameOf(x.port, x)));
  const rowsEl = $('#logRows');
  if (!hits.length) { rowsEl.innerHTML = '<div class="empty">还没有从本页面停止过服务</div>'; return; }
  rowsEl.innerHTML = hits.map((x, i) => `
    <div class="row compact log-row" data-idx="${i}">
      <div class="port" style="font-size:13px">${esc(fmtTime(x.ts))}</div>
      <div class="port" style="font-size:15px">${x.port}</div>
      <div>${nameCell(x.port, x)}</div>
      <div class="clickable" data-logdetail="${stoplog.indexOf(x)}" title="点击查看完整路径">
        <div class="pname">${esc(cmdTail(x.command.split(' ')[0], 34))} <span style="color:var(--dim);font-weight:400;font-size:11px">· ${x.pid}</span></div>
        <div class="pcmd">${esc(cmdTail(x.command))}</div>
      </div>
    </div>`).join('');
}

// ============ 名称解析：自定义别名 > 探测缓存 > 记录存档的识别名 ============
function nameOf(port, fromLog) {
  if (aliases[port]) return aliases[port];
  const t = titles[port];
  if (t && t.http && t.title) return t.title;
  if (fromLog && fromLog.title) return fromLog.title;
  return '';
}
// 独立名称列：默认自动带端口页的识别名，改名后全局同步
function nameCell(port, fromLog) {
  const nm = nameOf(port, fromLog);
  return nm
    ? `<div class="nm" data-aliasedit="${port}" title="点击改名，全局同步">🌐 ${esc(nm)}<span class="ed">✎</span></div>`
    : `<div class="nm none" data-aliasedit="${port}" title="点击命名">未命名<span class="ed">✎</span></div>`;
}
// 切到启动/停止记录页时，对记录里的端口补探测（没探测过的自动补上识别名）
async function probeLogPorts() {
  const targets = [...new Set(stoplog.map(x => x.port))].filter(p => titles[p] === undefined);
  if (!targets.length) return;
  await Promise.all(targets.map(async p => {
    try { titles[p] = await api('/api/probe?port=' + p); }
    catch { titles[p] = { http: false }; }
  }));
  renderLog();
  renderStarts();
}

// ============ 一键启动（从停止记录派生） ============
function inferStart(x) {
  const first = String(x.command || '').trim().split(/\s+/)[0] || '';
  const base = first.split(/[\\/]/).pop();
  if (/^node(\.exe)?$/i.test(base)) return { kind: 'node', ok: true };
  if (/^python(\d+(\.\d+)*)?(\.exe)?$/i.test(base) || /^python3(\.exe)?$/i.test(base)) return { kind: 'python', ok: true };
  if (/^(npm|npx|pnpm|yarn)(\.cmd)?$/i.test(base)) return { kind: 'npm/npx', ok: true };
  if (/^deno(\.exe)?$/i.test(base) || /^bun(\.exe)?$/i.test(base)) return { kind: base, ok: true };
  return { kind: '识别不出', ok: false };
}
function dedupeStarts() {
  const seen = new Map(); // command+cwd -> 最新记录
  for (const x of stoplog) seen.set(x.command + '\u0000' + (x.cwd || ''), x);
  return [...seen.values()].sort((a, b) => b.ts - a.ts);
}
function renderStarts() {
  const items = dedupeStarts().filter(x => match(x.port) || match(x.command) || match(x.cwd) || match(nameOf(x.port, x)));
  $('#startBadge').textContent = dedupeStarts().length;
  const rowsEl = $('#startRows');
  if (!items.length) { rowsEl.innerHTML = '<div class="empty">还没有记录——去「端口」页停掉一个服务，这里就会出现它的一键启动</div>'; return; }
  rowsEl.innerHTML = items.map((x, i) => {
    const inf = inferStart(x);
    const tag = inf.ok
      ? `<span class="tag me">${esc(inf.kind)}</span>`
      : '<span class="tag sys" title="看不出是 node/python 还是别的，启动按钮会原样执行整条命令，可能失败">识别不出</span>';
    const btn = `<button class="btn pri" data-start="${i}">${inf.ok ? '启动' : '照样启动'}</button>`;
    return `
    <div class="row compact log-row">
      <div>${tag}</div>
      <div class="port" style="font-size:13px" title="上次占用的端口">${x.port}</div>
      <div>${nameCell(x.port, x)}</div>
      <div class="clickable" data-logdetail="${stoplog.indexOf(x)}" title="点击查看完整命令与路径">
        <div class="pname">${esc(cmdTail(x.command, 44))}</div>
        <div class="pcmd">${esc(x.cwd || '（无路径记录）')}</div>
      </div>
      <div>${btn}</div>
    </div>`;
  }).join('');
}

async function doStart(idx) {
  const x = dedupeStarts()[idx];
  if (!x) return;
  const inf = inferStart(x);
  $('#mBox').innerHTML = `
    <h3>确认启动？</h3>
    <p>在 <b>${esc(x.cwd || '(当前目录)')}</b> 下执行：<br><span class="mono">${esc(x.command)}</span></p>
    ${inf.ok ? '' : '<p style="color:var(--warn)">⚠ 这条命令识别不出启动方式，将原样执行，可能失败或行为异常。</p>'}
    <div class="m-btns">
      <button class="btn" id="mCancel">算了</button>
      <button class="btn pri" id="mStartOk">启动它</button>
    </div>`;
  $('#modal').hidden = false;
  $('#mStartOk').addEventListener('click', async () => {
    try {
      await api('/api/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: x.command, cwd: x.cwd }) });
      $('#modal').hidden = true;
      loadLog().then(renderStarts);
      const url = 'http://127.0.0.1:' + x.port;
      const w = window.open(url, '_blank');
      toast(w ? `已启动——服务页已在新标签页打开（${url}），几秒后刷新即可` : `已启动。浏览器拦了新页面，手动访问 ${url}`);
      load();
    } catch (err) { toast('启动失败：' + err.message); }
  });
}

// ============ 别名编辑弹层 ============
function showAliasEdit(port) {
  const cur = aliases[port] || '';
  const t = titles[port];
  $('#mBox').innerHTML = `
    <h3>端口 ${port} · 自定义命名</h3>
    <p style="color:var(--dim)">改过的名字会记住，下次识别列直接显示它${t && t.http && t.title ? `（原识别：${esc(t.title)}）` : ''}</p>
    <input id="aliasInput" type="text" value="${esc(cur)}" placeholder="输入名字，留空=清除恢复自动识别" style="width:100%">
    <div class="m-btns">
      <button class="btn" id="aliasDel">清除</button>
      <button class="btn" id="mCancel">取消</button>
      <button class="btn pri" id="aliasSave">保存</button>
    </div>`;
  $('#modal').hidden = false;
  const input = $('#aliasInput');
  input.focus(); input.select();
  const save = async () => {
    try {
      aliases = (await api('/api/alias', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ port, name: input.value.trim() }) })).aliases;
      $('#modal').hidden = true;
      toast('已保存');
      renderPorts();
    } catch (err) { toast('保存失败：' + err.message); }
  };
  $('#aliasSave').addEventListener('click', save);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') save(); });
  $('#aliasDel').addEventListener('click', async () => {
    try {
      aliases = (await api('/api/alias', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ port, name: '' }) })).aliases;
      $('#modal').hidden = true;
      toast('已清除，恢复自动识别');
      renderPorts();
    } catch (err) { toast('失败：' + err.message); }
  });
}

// ============ 详情弹层 ============
function showDetail(pid, fromLog) {
  let x, port = '';
  if (fromLog) {
    const rec = stoplog[pid];
    x = { command: rec.command, cwd: rec.cwd, pid: rec.pid, user: '', cpu: null, rssMB: null };
    port = rec.port;
  } else {
    const p = ports.find(pp => pp.procs.some(xx => xx.pid === pid)); // data-detail 存的是 PID，按 PID 找
    if (!p) return;
    x = p.procs.find(xx => xx.pid === pid); port = p.port;
  }
  $('#mBox').innerHTML = `
    <h3>${port ? `端口 ${esc(port)} · ` : ''}进程 ${x.pid}</h3>
    <div class="kv"><span class="k">完整命令</span><span class="v mono">${esc(x.command)}</span></div>
    <div class="kv"><span class="k">工作目录</span><span class="v mono">${esc(x.cwd || '（拿不到，进程可能刚启动或权限不足）')}</span></div>
    ${x.user ? `<div class="kv"><span class="k">用户</span><span class="v">${esc(x.user)}</span></div>` : ''}
    ${x.cpu != null ? `<div class="kv"><span class="k">资源</span><span class="v">CPU ${x.cpu}% · 内存 ${x.rssMB ?? '—'}MB</span></div>` : ''}
    <div class="m-btns wrap">
      <button class="btn" data-copy="${esc(x.command)}">复制命令</button>
      ${x.cwd ? `<button class="btn" data-copy="${esc(x.cwd)}">复制路径</button>` : ''}
      ${x.cwd ? `<button class="btn pri" data-reveal="${esc(x.cwd)}">打开所在文件夹</button>` : ''}
      <button class="btn" id="dClose">关闭</button>
    </div>`;
  $('#modal').hidden = false;
}

document.addEventListener('click', async e => {
  const ae = e.target.closest('[data-aliasedit]');
  if (ae) return showAliasEdit(Number(ae.dataset.aliasedit));
  const sb = e.target.closest('[data-start]');
  if (sb) return doStart(Number(sb.dataset.start));
  const det = e.target.closest('[data-detail]');
  if (det) return showDetail(Number(det.dataset.detail), false);
  const logdet = e.target.closest('[data-logdetail]');
  if (logdet) return showDetail(Number(logdet.dataset.logdetail), true);
  const cp = e.target.closest('[data-copy]');
  if (cp) {
    await navigator.clipboard.writeText(cp.dataset.copy);
    toast('已复制');
    return;
  }
  const rv = e.target.closest('[data-reveal]');
  if (rv) {
    try { await api('/api/reveal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: rv.dataset.reveal }) }); toast('已在访达里打开'); }
    catch (err) { toast('打开失败：' + err.message); }
    return;
  }
  const btn = e.target.closest('[data-stop]');
  if (btn) {
    const port = Number(btn.dataset.stop);
    const p = ports.find(x => x.port === port);
    if (!p) return;
    const proc = p.procs[0];
    $('#mBox').innerHTML = `
      <h3>确认停止？</h3>
      <p>端口 <b>${port}</b> · ${esc(proc.command)}${proc.command.includes('portctl') ? '<br><b style="color:var(--warn)">这是端口管家自己——停掉后本页面会失联。</b>' : ''}</p>
      <div class="m-btns">
        <button class="btn" id="mCancel">算了</button>
        <button class="btn danger" id="mOk">停止它</button>
      </div>`;
    $('#modal').hidden = false;
  }
});

$('#mBox').addEventListener('click', async e => {
  if (e.target.id === 'mCancel' || e.target.id === 'dClose') { $('#modal').hidden = true; return; }
  if (e.target.id !== 'mOk') return;
  const btn = $('#mOk');
  const port = $('#mBox').querySelector('b');
  const pid = Number((port ? port.parentElement.textContent.match(/端口 (\d+)/) : [])[1]);
  const p = ports.find(x => x.port === pid);
  const pidNum = p ? p.procs[0].pid : null;
  try {
    const d = await api('/api/stop', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pid: pidNum })
    });
    toast(d.selfDied ? '端口管家已停止——重启：node server.js' : `已停止（端口 ${pid}）`);
    $('#modal').hidden = true;
    load();
    if (view === 'log') loadLog();
  } catch (err) { toast('停止失败：' + err.message); }
});
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') $('#modal').hidden = true; });
document.addEventListener('keydown', e => { if (e.key === 'Escape') $('#modal').hidden = true; });

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.hidden = true, 3200);
}

// ============ 视图切换 / 顶栏 ============
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
  view = t.dataset.view;
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('on', x === t));
  $('#view-ports').hidden = view !== 'ports';
  $('#view-start').hidden = view !== 'start';
  $('#view-log').hidden = view !== 'log';
  if (view === 'log' || view === 'start') loadLog().then(probeLogPorts);
}));

$('#refresh').addEventListener('click', () => {
  for (const k in titles) delete titles[k];
  if (view === 'log') loadLog(); else load();
});
$('#search').addEventListener('input', e => { keyword = e.target.value.trim().toLowerCase(); renderPorts(); renderLog(); });
$('#auto').addEventListener('change', e => {
  clearInterval(timer);
  if (e.target.checked) timer = setInterval(() => { if (!keyword && $('#modal').hidden && view === 'ports') load(); }, 5000);
});

load();
loadAliases();
