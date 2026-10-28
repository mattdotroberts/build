// build.happyoperators.com — zero-dependency Node server.
// Serves the static site from the repo root and a small JSON-backed
// notes API for the idea board at /p/t4p-ideaboard.
//
//   GET    /api/notes          -> { notes: [...] }
//   POST   /api/notes          { x, w, c } -> { note }   (max 30 pins/hour per IP)
//   DELETE /api/notes/<id>     -> { ok: true }
//
// Notes are stored in DATA_DIR (default ./data) as notes.json.
// Mount DATA_DIR as a volume in Coolify so notes survive redeploys.

const http = require('http');
const fs = require('fs');
const path = require('path');
const deploys = require('./deploy');
const sites = require('./sites');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const SITE = process.env.SITE_DOMAIN || 'build.happyoperators.com';
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'notes.json');
const MAX_NOTES = 300;

// ---------- storage ----------
let notes = [];
function loadNotes() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    notes = Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    notes = [];
  }
}
let saveTimer = null;
function saveNotes() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdir(DATA_DIR, { recursive: true }, () => {
      const tmp = DATA_FILE + '.tmp';
      fs.writeFile(tmp, JSON.stringify(notes), (err) => {
        if (err) return console.error('save failed:', err.message);
        fs.rename(tmp, DATA_FILE, () => {});
      });
    });
  }, 200);
}
loadNotes();

// ---------- helpers ----------
function send(res, code, body, type) {
  res.writeHead(code, {
    'Content-Type': type || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 10000) { reject(new Error('too large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function clean(s, max) {
  return String(s || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .trim()
    .slice(0, max);
}

// rate limit: max 30 pins per IP per hour
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const win = 60 * 60 * 1000;
  const arr = (hits.get(ip) || []).filter((t) => now - t < win);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return arr.length > 30;
}

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.htm': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.wasm': 'application/wasm'
};

function serveFile(res, full) {
  fs.readFile(full, (err, data) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    const type = STATIC_TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

// <name> when the request came in on <name>.build.happyoperators.com
function hostSub(req) {
  const host = String(req.headers.host || '').split(':')[0].toLowerCase();
  return host.endsWith('.' + SITE) ? host.slice(0, -SITE.length - 1) : '';
}

// ---------- /deploy page: the markdown in deploy.md, lightly rendered ----------
function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
}
function docsPage(md) {
  const out = [];
  let list = null;
  let para = [];
  const flush = () => {
    if (para.length) { out.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; }
    if (list) { out.push('</' + list + '>'); list = null; }
  };
  const lines = md.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('```')) {
      flush();
      const code = [];
      while (++i < lines.length && !lines[i].startsWith('```')) code.push(lines[i]);
      out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>');
    } else if (/^#{1,3} /.test(l)) {
      flush();
      const n = l.match(/^#+/)[0].length;
      out.push('<h' + n + '>' + inline(l.slice(n + 1)) + '</h' + n + '>');
    } else if (/^(- |\d+\. )/.test(l)) {
      if (para.length) { out.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; }
      const kind = l.startsWith('- ') ? 'ul' : 'ol';
      if (list !== kind) { if (list) out.push('</' + list + '>'); out.push('<' + kind + '>'); list = kind; }
      out.push('<li>' + inline(l.replace(/^(- |\d+\. )/, '')) + '</li>');
    } else if (!l.trim()) {
      flush();
    } else {
      para.push(l.trim());
    }
  }
  flush();
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">' +
    '<title>Deploy · Happy Operators</title><link rel="alternate" type="text/markdown" href="/deploy.md">' +
    '<link href="https://fonts.googleapis.com/css2?family=Onest:wght@400;600;700&family=JetBrains+Mono:wght@400&display=swap" rel="stylesheet">' +
    '<style>body{margin:0;background:#FAFAFA;color:#1A1A1A;font:16px/1.65 Onest,system-ui,sans-serif;-webkit-font-smoothing:antialiased}' +
    'main{max-width:760px;margin:0 auto;padding:28px 16px 80px}header{display:flex;align-items:center;justify-content:space-between;margin-bottom:40px}' +
    'header img{height:32px}header a.b{font-size:14px;font-weight:600;text-decoration:none;background:#0A0A0A;color:#FAFAFA;padding:8px 16px;border-radius:999px}' +
    'h1{font-size:clamp(30px,5vw,44px);line-height:1.1;letter-spacing:-.03em;margin:0 0 16px}h2{font-size:24px;letter-spacing:-.02em;margin:44px 0 10px}' +
    'a{color:#E6430F}code{font:13.5px "JetBrains Mono",monospace;background:#F0F0F0;padding:1px 5px;border-radius:5px}' +
    'pre{background:#0A0A0A;color:#E5E5E5;padding:14px 16px;border-radius:12px;overflow:auto}pre code{background:none;padding:0;color:inherit;font-size:13px}' +
    'li{margin:6px 0}p,ul,ol{color:#333}</style></head><body><main><header><a href="/"><img src="/brand/ho-lockup-dark.svg" alt="Happy Operators"></a>' +
    '<a class="b" href="/#deploy">Use the form</a></header>' + out.join('\n') + '</main></body></html>';
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  let p;
  try { p = new URL(req.url, 'http://localhost').pathname; }
  catch (e) { return send(res, 400, 'Bad request', 'text/plain'); }

  // ----- API -----
  if (await sites.handle(req, res, p, send, DATA_DIR)) return;
  if (await deploys.handle(req, res, p, send, readBody)) return;

  // ----- deploy docs: HTML for browsers, markdown for agents and curl -----
  if (['/deploy', '/deploy/', '/deploy.md', '/llms.txt'].includes(p) && !hostSub(req)) {
    const md = fs.readFileSync(path.join(ROOT, 'deploy.md'), 'utf8');
    const wantsHtml = p.startsWith('/deploy') && p !== '/deploy.md' && /text\/html/.test(req.headers.accept || '');
    if (!wantsHtml) return send(res, 200, md, 'text/markdown; charset=utf-8');
    return send(res, 200, docsPage(md), 'text/html; charset=utf-8');
  }

  if (p === '/api/notes' && req.method === 'GET') {
    return send(res, 200, JSON.stringify({ notes: notes }));
  }

  if (p === '/api/notes' && req.method === 'POST') {
    const ip = ((req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '';
    if (limited(ip)) return send(res, 429, JSON.stringify({ error: 'Too many pins from one address. Try again later.' }));
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch (e) { return send(res, 400, JSON.stringify({ error: 'Bad request' })); }
    const x = clean(body.x, 280);
    if (!x) return send(res, 400, JSON.stringify({ error: 'Empty idea' }));
    const note = {
      id: 'n' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36),
      x: x,
      w: clean(body.w, 60),
      c: ['1', '2', '3', '4'].includes(String(body.c)) ? String(body.c) : '1',
      t: Date.now()
    };
    notes.unshift(note);
    if (notes.length > MAX_NOTES) notes.length = MAX_NOTES;
    saveNotes();
    return send(res, 200, JSON.stringify({ note: note }));
  }

  const del = p.match(/^\/api\/notes\/([a-z0-9]+)$/);
  if (del && req.method === 'DELETE') {
    const i = notes.findIndex((n) => n.id === del[1]);
    if (i === -1) return send(res, 404, JSON.stringify({ error: 'No such note' }));
    notes.splice(i, 1);
    saveNotes();
    return send(res, 200, JSON.stringify({ ok: true }));
  }

  // ----- static -----
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'Method not allowed', 'text/plain');
  }

  // projects in ./p and uploaded sites live on their own subdomain: <name>.build.happyoperators.com
  const sub = hostSub(req);
  const old = p.match(/^\/p\/([a-z0-9-]+)\/?$/);
  if (!sub && old && fs.existsSync(path.join(ROOT, 'p', old[1], 'index.html'))) {
    res.writeHead(301, { Location: 'https://' + old[1] + '.' + SITE + '/' });
    return res.end();
  }
  let base = ROOT;
  if (sub) {
    const own = path.join(ROOT, 'p', sub);
    base = /^[a-z0-9-]+$/.test(sub) && fs.existsSync(own) ? own : sites.siteRoot(DATA_DIR, sub);
    if (!base) return send(res, 404, 'Not found', 'text/plain');
  }

  let file = p === '/' ? '/index.html' : decodeURIComponent(p);
  const full = path.normalize(path.join(base, file));
  if (!full.startsWith(base)) return send(res, 403, 'Forbidden', 'text/plain');

  fs.stat(full, (err, st) => {
    if (!err && st.isDirectory()) {
      if (!p.endsWith('/')) {
        // redirect to the trailing-slash form; relative Location keeps the
        // proxy's host and port out of the URL (the old nginx :3000 bug)
        res.writeHead(301, { Location: p + '/' });
        return res.end();
      }
      return serveFile(res, path.join(full, 'index.html'));
    }
    serveFile(res, full);
  });
});

server.listen(PORT, () => console.log('build.happyoperators.com listening on port ' + PORT));
