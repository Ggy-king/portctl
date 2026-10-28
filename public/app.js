// 端口管家 · 前端逻辑（端口列表 / 停止记录 / 详情弹层）
const $ = s => document.querySelector(s);
let ME = '', PLATFORM = '';
let ports = [], stoplog = [];
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
    const http = t
      ? (t.http
        ? `<div class="http"><div class="t">${esc(t.title || '(HTTP，无标题)')}</div><div class="s">HTTP ${t.status}${t.server ? ' · ' + esc(t.server) : ''}</div></div>`
        : '<div class="http none">非 HTTP 服务</div>')
      : '<div class="http none">探测中…</div>';
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
  const hits = stoplog.filter(x => match(x.port) || match(x.command) || match(x.cwd) || match(x.ts && fmtTime(x.ts)));
  const rowsEl = $('#logRows');
  if (!hits.length) { rowsEl.innerHTML = '<div class="empty">还没有从本页面停止过服务</div>'; return; }
  rowsEl.innerHTML = hits.map((x, i) => `
    <div class="row compact log-row" data-idx="${i}">
      <div class="port" style="font-size:13px">${esc(fmtTime(x.ts))}</div>
      <div class="port" style="font-size:15px">${x.port}</div>
      <div class="clickable" data-logdetail="${stoplog.indexOf(x)}" title="点击查看完整路径">
        <div class="pname">${esc(cmdTail(x.command.split(' ')[0], 34))} <span style="color:var(--dim);font-weight:400;font-size:11px">· ${x.pid}</span></div>
        <div class="pcmd">${esc(cmdTail(x.command))}</div>
      </div>
    </div>`).join('');
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
  $('#view-log').hidden = view !== 'log';
  if (view === 'log') loadLog();
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
