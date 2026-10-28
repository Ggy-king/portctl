// 端口管家 portctl — 查看本机所有监听端口 / 识别网页标题 / 一键停止 / 停止记录
// 零依赖 Node >= 18。macOS 与 Windows 通用（自动识别平台）。只监听 127.0.0.1。
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PORT = 9123;
const PUB = path.join(__dirname, 'public');
const LOG_DIR = path.join(__dirname, 'data');
const LOG_PATH = path.join(LOG_DIR, 'stoplog.json');
const ME = require('os').userInfo().username;
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

const KNOWN = { 5000: '隔空播放', 7000: '隔空播放接收', 7100: '隔空播放接收', 62078: 'iPhone 同步', 135: 'RPC 远程调用', 445: '文件共享' };

const sh = (cmd, args) => new Promise((ok, err) =>
  execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024 }, (e, so, se) => e ? err(new Error(String(se || e.message))) : ok(so)));

// ============ macOS：lsof + ps ============
async function scanMac() {
  const out = await sh('/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '+c0']);
  const byPort = new Map();
  for (const line of out.split('\n')) {
    if (!/TCP/.test(line)) continue;
    const parts = line.replace(/\s*\(LISTEN\)\s*$/, '').trim().split(/\s+/);
    if (parts.length < 9) continue;
    const [command, pidStr, user] = parts;
    const addr = parts[parts.length - 1];
    const port = Number(addr.split(':').pop());
    if (!port) continue;
    let e = byPort.get(port);
    if (!e) { e = { port, addrs: new Set(), pids: new Map() }; byPort.set(port, e); }
    e.addrs.add(addr);
    if (!e.pids.has(pidStr)) e.pids.set(pidStr, { pid: Number(pidStr), command, user });
  }
  const pids = [...new Set([...byPort.values()].flatMap(p => [...p.pids.keys()]))];
  const detail = new Map(), cwdMap = new Map();
  if (pids.length) {
    try {
      const psOut = await sh('/bin/ps', ['-o', 'pid=,pcpu=,pmem=,rss=,user=,command=', '-p', pids.join(',')]);
      for (const l of psOut.split('\n')) {
        const m = l.trim().match(/^(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.*)$/);
        if (m) detail.set(Number(m[1]), { cpu: +m[2], mem: +m[3], rssMB: Math.round(m[4] / 1024 * 10) / 10, user: m[5], full: m[6] });
      }
    } catch {}
    try { // 工作目录：点开详情能看到这个服务"从哪个文件夹跑起来的"
      const cOut = await sh('/usr/sbin/lsof', ['-a', '-d', 'cwd', '-Fn', '-p', pids.join(',')]);
      let cur = null;
      for (const l of cOut.split('\n')) {
        if (l.startsWith('p')) cur = l.slice(1);
        else if (l.startsWith('n') && cur) { cwdMap.set(Number(cur), l.slice(1)); cur = null; }
      }
    } catch {}
  }
  return [...byPort.values()].map(e => ({
    port: e.port,
    addrs: [...e.addrs],
    procs: [...e.pids.values()].map(p => {
      const d = detail.get(p.pid) || {};
      return {
        pid: p.pid,
        command: d.full || p.command,
        user: d.user || p.user,
        cpu: d.cpu ?? null, mem: d.mem ?? null, rssMB: d.rssMB ?? null,
        cwd: cwdMap.get(p.pid) || '',
      };
    }),
    mine: [...e.pids.values()].every(p => (detail.get(p.pid) || {}).user === ME || p.user === ME),
    known: KNOWN[e.port] || null,
    kind: KNOWN[e.port] ? 'system' : (e.port >= 49152 ? 'dynamic' : 'app'),
  })).sort((a, b) => a.port - b.port);
}

// ============ Windows：netstat + PowerShell ============
async function scanWin() {
  const out = await sh('netstat', ['-ano', '-p', 'tcp']);
  const byPort = new Map();
  for (const line of out.split('\n')) {
    if (!/LISTENING/i.test(line)) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const local = parts[1];
    const port = Number(local.split(':').pop());
    const pid = Number(parts[parts.length - 1]);
    if (!port || !pid) continue;
    let e = byPort.get(port);
    if (!e) { e = { port, addrs: new Set(), pids: new Map() }; byPort.set(port, e); }
    e.addrs.add(local);
    if (!e.pids.has(pid)) e.pids.set(pid, { pid, command: '', user: ME });
  }
  const pids = [...new Set([...byPort.values()].flatMap(p => [...p.pids.keys()]))];
  if (pids.length) {
    try {
      const script = `$ids = @(${pids.join(',')}); Get-CimInstance Win32_Process | Where-Object { $ids -contains $_.ProcessId } | Select-Object ProcessId,Name,CommandLine,ExecutablePath,WorkingSetSize | ConvertTo-Json -Compress`;
      const j = await sh('powershell', ['-NoProfile', '-Command', script]);
      const arr = j.trim().startsWith('[') ? JSON.parse(j) : [JSON.parse(j)];
      for (const d of arr) {
        for (const e of byPort.values()) {
          const p = e.pids.get(d.ProcessId);
          if (p && !p.command) {
            p.command = d.CommandLine || d.ExecutablePath || d.Name || '';
            p.exe = d.ExecutablePath || '';
            p.rssMB = d.WorkingSetSize ? Math.round(d.WorkingSetSize / 1048576 * 10) / 10 : null;
            p.cwd = d.ExecutablePath ? path.dirname(d.ExecutablePath) : '';
          }
        }
      }
    } catch {}
  }
  return [...byPort.values()].map(e => ({
    port: e.port,
    addrs: [...e.addrs],
    procs: [...e.pids.values()].map(p => ({
      pid: p.pid, command: p.command || '(未知)', user: ME,
      cpu: null, mem: null, rssMB: p.rssMB ?? null, cwd: p.cwd || '',
    })),
    mine: true, // Windows 单用户机器，进程属主查询成本高，默认都可停
    known: KNOWN[e.port] || null,
    kind: KNOWN[e.port] ? 'system' : (e.port >= 49152 ? 'dynamic' : 'app'),
  })).sort((a, b) => a.port - b.port);
}

const scanPorts = () => IS_WIN ? scanWin() : scanMac();

// ============ HTTP 探测 ============
async function probe(port) {
  const go = (url) => new Promise((ok) => {
    const req = http.get(url, { timeout: 1500 }, res => {
      let buf = '';
      res.on('data', c => { if (buf.length < 65536) buf += c; });
      res.on('end', () => ok({ status: res.statusCode, server: res.headers.server || '', body: buf, location: res.headers.location || '' }));
      res.on('error', () => ok(null));
    });
    req.on('timeout', () => { req.destroy(); ok(null); });
    req.on('error', () => ok(null));
  });
  let r = await go(`http://127.0.0.1:${port}/`);
  if (r && r.location && /^http:\/\/127\.0\.0\.1/.test(r.location)) r = await go(r.location);
  if (!r) return { http: false };
  const m = r.body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = m ? m[1].replace(/\s+/g, ' ').trim().slice(0, 60) : '';
  return { http: true, status: r.status, server: r.server.slice(0, 40), title: title || (r.status === 200 ? '(200，无标题)' : `HTTP ${r.status}`) };
}

// ============ 停止记录（自己页面上停的才会入册；终端里手动 kill 的查不到，别冤枉工具） ============
function loadLog() {
  try { return JSON.parse(fs.readFileSync(LOG_PATH, 'utf8')); } catch { return []; }
}
function saveLog(log) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(LOG_PATH, JSON.stringify(log.slice(-200), null, 1));
}

async function stopPid(pid) {
  const cur = await scanPorts();
  const hit = cur.find(p => p.procs.some(x => x.pid === pid));
  if (!hit) throw new Error('该进程已不在监听列表里，刷新后再试');
  const proc = hit.procs.find(x => x.pid === pid);
  if (!IS_WIN && proc.user !== ME) throw new Error(`无权限：${proc.user} 的进程（多半是系统服务，不要动）`);
  if (/^(launchd|kernel_task|WindowServer|loginwindow|Finder|System)$/.test(String(proc.command.split(/[\\/]/).pop().split(' ')[0]))) {
    throw new Error('系统关键进程，拒绝停止');
  }
  if (IS_WIN) await sh('taskkill', ['/PID', String(pid), '/F']);
  else process.kill(pid);
  saveLog([...loadLog(), {
    ts: Date.now(), port: hit.port, pid, command: proc.command, cwd: proc.cwd || '', user: proc.user,
  }]);
  return { port: hit.port, command: proc.command, cwd: proc.cwd || '' };
}

// 在访达/资源管理器里显示某个路径
async function reveal(p) {
  if (!p || !fs.existsSync(p)) throw new Error('路径不存在');
  if (IS_WIN) await sh('explorer', ['/select,', p]);
  else if (IS_MAC) await sh('/usr/bin/open', ['-R', p]);
  else await sh('xdg-open', [p]);
}

function serveStatic(req, res) {
  const p = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const file = path.join(PUB, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };
  fs.readFile(file, (e, buf) => {
    if (e) { res.writeHead(404); return res.end('Not Found'); }
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}

let dying = false;
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  try {
    if (u.pathname === '/api/ports') return res.end(JSON.stringify({ me: ME, platform: process.platform, ports: await scanPorts() }));
    if (u.pathname === '/api/probe') {
      const port = Number(u.searchParams.get('port'));
      if (!port) { res.writeHead(400); return res.end('{"error":"no port"}'); }
      return res.end(JSON.stringify(await probe(port)));
    }
    if (u.pathname === '/api/stoplog') return res.end(JSON.stringify({ log: loadLog().slice(-200).reverse() }));
    if (req.method === 'POST' && u.pathname === '/api/stop') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        try {
          const pid = Number(JSON.parse(body).pid);
          const r = await stopPid(pid);
          if (pid === process.pid) dying = true;
          res.end(JSON.stringify({ ok: true, selfDied: pid === process.pid, ...r }));
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.code === 'EPERM' ? '无权限停止该进程' : e.message }));
        }
      });
      return;
    }
    if (req.method === 'POST' && u.pathname === '/api/reveal') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        try { await reveal(JSON.parse(body).path); res.end(JSON.stringify({ ok: true })); }
        catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
      });
      return;
    }
    serveStatic(req, res);
  } catch (e) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.on('error', async (e) => {
  if (e.code === 'EADDRINUSE') {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/ports`);
      if (r.ok) {
        console.log(`[端口管家] 已经在运行了，浏览器打开 http://127.0.0.1:${PORT} 即可，无需重复启动`);
        process.exit(0);
      }
    } catch {}
    try {
      const out = await new Promise(ok => execFile(IS_WIN ? 'netstat' : '/usr/sbin/lsof', IS_WIN ? ['-ano', '-p', 'tcp'] : ['-nP', '-iTCP:9123', '-sTCP:LISTEN'], (e2, so) => ok(e2 ? '' : so.trim())));
      console.error(`[端口管家] 端口 ${PORT} 被别的程序占用：\n${out.split('\n').filter(l => l.includes('9123') || l.includes('LISTEN')).slice(0, 3).join('\n') || '（占用者未知）'}\n想腾出来：${IS_WIN ? 'netstat -ano 找 PID 后 taskkill /PID x /F' : `lsof -ti :9123 | xargs kill`}`);
    } catch {
      console.error(`[端口管家] 端口 ${PORT} 被占用`);
    }
    process.exit(1);
  }
  console.error('[端口管家] 启动失败:', e.message);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[端口管家] http://127.0.0.1:${PORT} （只对本机开放 · 平台: ${process.platform}）`);
});

process.on('SIGINT', () => { if (!dying) process.exit(0); });
