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

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
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
  '.webmanifest': 'application/manifest+json'
};

function serveFile(res, full) {
  fs.readFile(full, (err, data) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    const type = STATIC_TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  let p;
  try { p = new URL(req.url, 'http://localhost').pathname; }
  catch (e) { return send(res, 400, 'Bad request', 'text/plain'); }

  // ----- API -----
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

  let file = p === '/' ? '/index.html' : decodeURIComponent(p);
  const full = path.normalize(path.join(ROOT, file));
  if (!full.startsWith(ROOT)) return send(res, 403, 'Forbidden', 'text/plain');

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
