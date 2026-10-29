// build.happyoperators.com — zero-dependency Node server.
// Serves the home page, projects in ./p and uploaded sites on <name>.build.happyoperators.com,
// plus the deploy and upload APIs (deploy.js, sites.js).
// DATA_DIR (a Coolify volume) holds uploaded sites so they survive redeploys.

const http = require('http');
const fs = require('fs');
const path = require('path');
const deploys = require('./deploy');
const sites = require('./sites');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const SITE = process.env.SITE_DOMAIN || 'build.happyoperators.com';
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');

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

function serveFile(res, full, pageUrl) {
  fs.readFile(full, (err, data) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    const ext = path.extname(full).toLowerCase();
    const type = STATIC_TYPES[ext] || 'application/octet-stream';
    if ((ext === '.html' || ext === '.htm') && pageUrl) data = addShareTags(data.toString('utf8'), pageUrl);
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

// ---------- link previews: fill in any missing Open Graph / Twitter tags ----------
const SHARE_IMAGE = 'https://' + SITE + '/brand/og.png';
function attr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
function plain(s) {
  return String(s).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&#?\w+;/g, ' ').replace(/\s+/g, ' ').trim();
}
function addShareTags(html, pageUrl) {
  let head = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
  if (!head) {
    // bare fragment or no <head>: give it one so previews still work
    html = /<html[^>]*>/i.test(html) ? html.replace(/<html[^>]*>/i, (t) => t + '<head></head>') : '<head></head>\n' + html;
    head = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
  }
  const has = (prop) => new RegExp('<meta[^>]+(property|name)=["\']' + prop.replace(/[:.]/g, '\\$&') + '["\']', 'i').test(head[1]);
  const meta = (prop) => {
    const m = head[1].match(new RegExp('<meta[^>]+(?:property|name)=["\']' + prop.replace(/[:.]/g, '\\$&') + '["\'][^>]*content=["\']([^"\']*)', 'i'));
    return m ? m[1] : '';
  };
  const titleTag = head[1].match(/<title[^>]*>([^<]*)<\/title>/i);
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = meta('og:title') || plain(titleTag ? titleTag[1] : '') || plain(h1 ? h1[1] : '') || new URL(pageUrl).host;
  let desc = meta('og:description') || meta('description');
  if (!desc) {
    const h1At = html.search(/<\/h1>/i);
    const ps = html.slice(h1At > -1 ? h1At : 0).match(/<p[^>]*>([\s\S]*?)<\/p>/gi) || [];
    const first = ps.map(plain).find((t) => t.length > 40);
    desc = first || 'Built and shipped on ' + SITE + ' by Happy Operators.';
  }
  if (desc.length > 200) desc = desc.slice(0, 197).replace(/\s+\S*$/, '') + '…';
  const add = [];
  const put = (prop, val, kind) => { if (!has(prop)) add.push('<meta ' + (kind || 'property') + '="' + prop + '" content="' + attr(val) + '">'); };
  put('description', desc, 'name');
  put('og:type', 'website');
  put('og:site_name', 'Happy Operators · build');
  put('og:title', title);
  put('og:description', desc);
  put('og:url', pageUrl);
  put('og:image', SHARE_IMAGE);
  if (!has('og:image')) { put('og:image:width', '1200'); put('og:image:height', '630'); }
  put('twitter:card', 'summary_large_image', 'name');
  put('twitter:title', title, 'name');
  put('twitter:description', desc, 'name');
  put('twitter:image', meta('og:image') || SHARE_IMAGE, 'name');
  if (!add.length) return html;
  return html.replace(/<\/head>/i, add.join('\n') + '\n</head>');
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
    '<title>Deploy · Happy Operators</title><meta name="description" content="Put your website or app live at your own address on build.happyoperators.com. Drop the files or link a GitHub repo. Works with Claude, Codex and other AI agents."><link rel="alternate" type="text/markdown" href="/deploy.md">' +
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

// ---------- everything live on <name>.build.happyoperators.com, for the home page ----------
// Built-in projects (./p), uploaded sites and GitHub deploys, newest first. Cached for a minute.
function pageInfo(file) {
  try {
    const html = fs.readFileSync(file, 'utf8').slice(0, 200000);
    const t = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    const d = html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)/i)
      || html.match(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']*)/i);
    const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    return { title: plain(t ? t[1] : h1 ? h1[1] : ''), desc: d ? plain(d[1]) : '', updated: fs.statSync(file).mtimeMs };
  } catch (e) { return { title: '', desc: '', updated: 0 }; }
}
let projectsCache = { at: 0, data: null };
async function projects() {
  if (projectsCache.data && Date.now() - projectsCache.at < 60000) return projectsCache.data;
  const out = new Map();
  const urlFor = (n) => 'https://' + n + '.' + SITE;
  for (const n of fs.readdirSync(path.join(ROOT, 'p'))) {
    const f = path.join(ROOT, 'p', n, 'index.html');
    if (fs.existsSync(f)) out.set(n, Object.assign({ name: n, url: urlFor(n), kind: 'Happy Operators' }, pageInfo(f)));
  }
  const up = path.join(DATA_DIR, 'sites');
  if (fs.existsSync(up)) {
    for (const n of fs.readdirSync(up)) {
      const f = path.join(up, n, 'index.html');
      if (!n.startsWith('.') && !out.has(n) && fs.existsSync(f)) out.set(n, Object.assign({ name: n, url: urlFor(n), kind: 'Upload' }, pageInfo(f)));
    }
  }
  try {
    const apps = await deploys.liveApps();
    for (const [n, a] of apps) {
      if (out.has(n) || /mattdotroberts\/build$/i.test(a.repo)) continue;
      const repo = String(a.repo || '').replace(/^https:\/\/github\.com\//, '');
      out.set(n, { name: n, url: urlFor(n), kind: 'GitHub', title: '', desc: repo ? 'From github.com/' + repo : '', updated: 0 });
    }
  } catch (e) { /* Coolify down: still show what we have on disk */ }
  const list = [...out.values()].sort((a, b) => (b.updated || 0) - (a.updated || 0) || a.name.localeCompare(b.name));
  projectsCache = { at: Date.now(), data: list };
  return list;
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  let p;
  try { p = new URL(req.url, 'http://localhost').pathname; }
  catch (e) { return send(res, 400, 'Bad request', 'text/plain'); }

  // ----- API -----
  if (p === '/api/projects' && req.method === 'GET') return send(res, 200, JSON.stringify({ projects: await projects() }));
  if ((p === '/api/sites' || p === '/api/deploys') && req.method !== 'GET') projectsCache.at = 0; // something changed: refresh the list
  if (await sites.handle(req, res, p, send, DATA_DIR)) return;
  if (await deploys.handle(req, res, p, send, readBody)) return;

  // ----- deploy docs: HTML for browsers, markdown for agents and curl -----
  if (['/deploy', '/deploy/', '/deploy.md', '/llms.txt'].includes(p) && !hostSub(req)) {
    const md = fs.readFileSync(path.join(ROOT, 'deploy.md'), 'utf8');
    const wantsHtml = p.startsWith('/deploy') && p !== '/deploy.md' && /text\/html/.test(req.headers.accept || '');
    if (!wantsHtml) return send(res, 200, md, 'text/markdown; charset=utf-8');
    return send(res, 200, addShareTags(docsPage(md), 'https://' + SITE + '/deploy'), 'text/html; charset=utf-8');
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
  const pageUrl = 'https://' + (sub ? sub + '.' : '') + SITE + p;

  fs.stat(full, (err, st) => {
    if (!err && st.isDirectory()) {
      if (!p.endsWith('/')) {
        // redirect to the trailing-slash form; relative Location keeps the
        // proxy's host and port out of the URL (the old nginx :3000 bug)
        res.writeHead(301, { Location: p + '/' });
        return res.end();
      }
      return serveFile(res, path.join(full, 'index.html'), pageUrl);
    }
    serveFile(res, full, pageUrl);
  });
});

server.listen(PORT, () => console.log('build.happyoperators.com listening on port ' + PORT));
