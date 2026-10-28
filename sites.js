// Static site uploads for build.happyoperators.com.
// Drop a folder, a zip or a single HTML file; it is served from
// <name>.build.happyoperators.com straight out of DATA_DIR/sites/<name>.
//
//   GET  /api/sites            -> how to call this (for people and agents)
//   POST /api/sites            upload. Either:
//        Content-Type: application/zip   (raw zip body; name, code, key in the query string)
//        Content-Type: text/html         (one page; becomes index.html)
//        Content-Type: application/json  { name, code, key, files: [{ path, base64 | content }] }
//   -> { name, url, key, live, deployment }
//   DELETE /api/sites?name=&key=   remove your site
//
// The first upload of a name returns a key. Send it back to update that site.
// A new name is added to this app's domains in Coolify, which needs one redeploy
// (about a minute); updates to an existing site are live at once.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const deploys = require('./deploy');

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 2000;
const ALLOWED = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.json', '.txt', '.xml', '.svg', '.png', '.jpg',
  '.jpeg', '.gif', '.webp', '.avif', '.ico', '.woff', '.woff2', '.ttf', '.otf', '.mp4', '.webm', '.mp3', '.wav',
  '.ogg', '.pdf', '.webmanifest', '.map', '.md', '.csv', '.glb', '.gltf', '.wasm']);

function sitesDir(dataDir) { return path.join(dataDir, 'sites'); }
function metaFile(dataDir, name) { return path.join(dataDir, 'sites-meta', name + '.json'); }
function hash(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

function readRaw(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BYTES * 1.4) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---------- minimal zip reader (stored + deflate) ----------
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw Object.assign(new Error('That does not look like a zip file.'), { status: 400 });
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw Object.assign(new Error('Broken zip file.'), { status: 400 });
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.slice(start, start + csize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw, { maxOutputLength: MAX_BYTES });
    else throw Object.assign(new Error('Unsupported zip compression in ' + name), { status: 400 });
    files.push({ path: name, data: data });
  }
  return files;
}

// clean paths, drop junk, strip one shared top folder, check what is left
function tidy(files) {
  let list = files
    .map((f) => ({ path: String(f.path || '').replace(/\\/g, '/').replace(/^\/+/, ''), data: f.data }))
    .filter((f) => f.path && !f.path.split('/').some((s) => s.startsWith('.') || s === '__MACOSX' || s === 'node_modules'));
  const tops = new Set(list.map((f) => f.path.split('/')[0]));
  if (tops.size === 1 && list.every((f) => f.path.includes('/')) && !list.some((f) => f.path === 'index.html')) {
    const top = [...tops][0] + '/';
    list = list.map((f) => ({ path: f.path.slice(top.length), data: f.data }));
  }
  // a single html file becomes the home page
  if (list.length === 1 && /\.html?$/i.test(list[0].path)) list[0].path = 'index.html';
  if (!list.length) throw Object.assign(new Error('No files found.'), { status: 400 });
  if (list.length > MAX_FILES) throw Object.assign(new Error('Too many files (max ' + MAX_FILES + ').'), { status: 400 });
  let total = 0;
  for (const f of list) {
    if (f.path.split('/').some((s) => s === '..' || s === '')) throw Object.assign(new Error('Bad file path: ' + f.path), { status: 400 });
    const ext = path.extname(f.path).toLowerCase();
    if (!ALLOWED.has(ext)) throw Object.assign(new Error('Not allowed: ' + f.path + '. Static sites only (HTML, CSS, JS, images, fonts, media).'), { status: 400 });
    total += f.data.length;
  }
  if (total > MAX_BYTES) throw Object.assign(new Error('Too big: max 25 MB unpacked.'), { status: 413 });
  if (!list.some((f) => f.path === 'index.html')) {
    if (list.some((f) => f.path === 'dist/index.html' || f.path === 'build/index.html' || f.path === 'out/index.html')) {
      throw Object.assign(new Error('Found a built site in dist/, build/ or out/. Upload that folder, not the project.'), { status: 400 });
    }
    if (list.some((f) => f.path === 'package.json')) {
      throw Object.assign(new Error('This looks like source code. Run the build first, then upload the output folder (usually dist/).'), { status: 400 });
    }
    throw Object.assign(new Error('Needs an index.html at the top level.'), { status: 400 });
  }
  return { files: list, bytes: total };
}

function writeSite(dataDir, name, files) {
  const root = sitesDir(dataDir);
  const tmp = path.join(root, '.tmp-' + name + '-' + Date.now());
  for (const f of files) {
    const full = path.join(tmp, f.path);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, f.data);
  }
  const dest = path.join(root, name);
  const old = path.join(root, '.old-' + name + '-' + Date.now());
  if (fs.existsSync(dest)) fs.renameSync(dest, old);
  fs.renameSync(tmp, dest);
  if (fs.existsSync(old)) fs.rmSync(old, { recursive: true, force: true });
}

// this app in Coolify (the one serving build.happyoperators.com)
async function selfApp() {
  const apps = await deploys.api('GET', '/applications');
  const root = 'https://' + deploys.DOMAIN;
  return (apps || []).find((a) => String(a.fqdn || '').split(',').some((d) => d.trim().replace(/\/$/, '') === root));
}

// one domain change at a time, re-reading the list each time so uploads don't drop each other's names
let lock = Promise.resolve();
function addDomain(url) {
  const run = lock.then(async () => {
    const self = await selfApp();
    const domains = String(self.fqdn || '').split(',').map((d) => d.trim()).filter(Boolean);
    if (domains.includes(url)) return null;
    domains.push(url);
    await deploys.api('PATCH', '/applications/' + self.uuid, { domains: domains.join(',') });
    const queued = await deploys.api('POST', '/deploy?uuid=' + encodeURIComponent(self.uuid));
    const d = queued && queued.deployments && queued.deployments[0];
    return d ? d.deployment_uuid : null;
  });
  lock = run.catch(() => {});
  return run;
}

const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 3600000);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return arr.length > 20;
}

function usage() {
  return {
    what: 'Host a static website (HTML, CSS, JS, images) at https://<name>.' + deploys.DOMAIN,
    docs: 'https://' + deploys.DOMAIN + '/deploy',
    needs: {
      name: '3-30 chars, lowercase letters, numbers, dashes. Becomes <name>.' + deploys.DOMAIN,
      code: deploys.CODE ? 'access code from the person who shared this link' : 'not needed',
      key: 'only when updating a site you uploaded before (returned by the first upload)',
      files: 'a zip, a single HTML file, or JSON {files:[{path, base64}]}. Needs index.html at the top. Max 25 MB.'
    },
    example: 'curl -X POST --data-binary @site.zip -H "Content-Type: application/zip" "https://' + deploys.DOMAIN + '/api/sites?name=my-site&code=CODE"'
  };
}

async function upload(req, q, dataDir, ip) {
  if (!deploys.TOKEN) return [503, { error: 'Deploys are not switched on yet.' }];
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const raw = await readRaw(req);

  let body = {};
  let files;
  if (type === 'application/json') {
    try { body = JSON.parse(raw.toString('utf8')); } catch (e) { return [400, { error: 'Bad JSON.' }]; }
    files = (Array.isArray(body.files) ? body.files : []).map((f) => ({
      path: f.path,
      data: f.base64 != null ? Buffer.from(String(f.base64), 'base64') : Buffer.from(String(f.content || ''), 'utf8')
    }));
  }
  const name = String(body.name || q.get('name') || '').trim().toLowerCase();
  const code = String(body.code || q.get('code') || req.headers['x-deploy-code'] || '').trim();
  const key = String(body.key || q.get('key') || req.headers['x-site-key'] || '').trim();

  const missing = [];
  if (!name) missing.push('name');
  if (deploys.CODE && !code) missing.push('code');
  if (!raw.length || (files && !files.length)) missing.push('files');
  if (missing.length) return [400, Object.assign({ error: 'Missing: ' + missing.join(', ') + '.', missing: missing }, usage())];

  if (deploys.CODE && code !== deploys.CODE) return [403, { error: 'That access code is not right. Ask the person who gave you this link.' }];
  if (limited(ip)) return [429, { error: 'Too many uploads from one address. Try again in an hour.' }];
  if (!deploys.NAME_RE.test(name)) return [400, { error: 'Name must be 3 to 30 characters: lowercase letters, numbers and dashes.' }];
  if (deploys.RESERVED.has(name) || fs.existsSync(path.join(__dirname, 'p', name))) return [409, { error: 'That name is taken. Pick another.' }];

  if (!files) {
    if (type === 'application/zip' || type === 'application/x-zip-compressed' || (raw.length >= 4 && raw.readUInt32LE(0) === 0x04034b50)) files = unzip(raw);
    else if (type === 'text/html') files = [{ path: 'index.html', data: raw }];
    else return [415, Object.assign({ error: 'Send a zip (application/zip), one HTML page (text/html) or JSON.' }, usage())];
  }
  const site = tidy(files);

  // who owns this name?
  const meta = metaFile(dataDir, name);
  const apps = await deploys.liveApps();
  const self = await selfApp();
  if (!self) return [500, { error: 'Could not find the build app in Coolify.' }];
  const holder = apps.get(name);
  if (holder && holder.uuid !== self.uuid) return [409, { error: name + '.' + deploys.DOMAIN + ' is already used by a GitHub deploy. Pick another name.' }];

  let newKey = null;
  if (fs.existsSync(meta)) {
    const m = JSON.parse(fs.readFileSync(meta, 'utf8'));
    if (!key || hash(key) !== m.keyHash) return [409, { error: name + '.' + deploys.DOMAIN + ' is taken. To update your own site, send the key you got the first time. Otherwise pick another name.' }];
  } else {
    if (apps.size >= deploys.MAX_APPS) return [409, { error: 'The server is full right now. Ask Matt to make room.' }];
    newKey = crypto.randomBytes(18).toString('base64url');
  }

  writeSite(dataDir, name, site.files);
  fs.mkdirSync(path.dirname(meta), { recursive: true });
  const prev = fs.existsSync(meta) ? JSON.parse(fs.readFileSync(meta, 'utf8')) : {};
  fs.writeFileSync(meta, JSON.stringify({
    keyHash: newKey ? hash(newKey) : prev.keyHash,
    created: prev.created || Date.now(),
    updated: Date.now(),
    files: site.files.length,
    bytes: site.bytes
  }));

  // first time: route the new subdomain to this app (one redeploy)
  let deployment = null;
  const url = deploys.urlFor(name);
  const domains = String(self.fqdn || '').split(',').map((d) => d.trim()).filter(Boolean);
  if (!domains.includes(url)) deployment = await addDomain(url);

  const out = {
    name: name,
    url: url,
    live: !deployment,
    deployment: deployment,
    files: site.files.length,
    bytes: site.bytes,
    message: deployment
      ? 'Uploaded. Your address goes live in about a minute (the padlock can take a moment longer).'
      : 'Updated. Live now.'
  };
  if (newKey) {
    out.key = newKey;
    out.message += ' Save the key: you need it to update this site later.';
  }
  return [200, out];
}

async function remove(q, dataDir) {
  const name = String(q.get('name') || '').trim().toLowerCase();
  const key = String(q.get('key') || '').trim();
  const meta = metaFile(dataDir, name);
  if (!deploys.NAME_RE.test(name) || !fs.existsSync(meta)) return [404, { error: 'No uploaded site with that name.' }];
  if (!key || hash(key) !== JSON.parse(fs.readFileSync(meta, 'utf8')).keyHash) return [403, { error: 'Wrong or missing key.' }];
  fs.rmSync(path.join(sitesDir(dataDir), name), { recursive: true, force: true });
  fs.rmSync(meta, { force: true });
  const url = deploys.urlFor(name);
  const run = lock.then(async () => {
    const self = await selfApp();
    const domains = String(self.fqdn || '').split(',').map((d) => d.trim()).filter((d) => d && d !== url);
    await deploys.api('PATCH', '/applications/' + self.uuid, { domains: domains.join(',') });
    await deploys.api('POST', '/deploy?uuid=' + encodeURIComponent(self.uuid));
  });
  lock = run.catch(() => {});
  await run;
  return [200, { ok: true, message: url + ' is gone.' }];
}

// returns true if it handled the request
async function handle(req, res, p, send, dataDir) {
  if (p !== '/api/sites') return false;
  const ip = ((req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '';
  const json = (code, obj) => { send(res, code, JSON.stringify(obj, null, 2)); return true; };
  if (req.method === 'GET') return json(200, usage());
  if (req.method !== 'POST' && req.method !== 'DELETE') return json(405, { error: 'Use POST to upload, DELETE to remove, GET for instructions.' });
  try {
    const q = new URL(req.url, 'http://localhost').searchParams;
    const [code, out] = req.method === 'DELETE' ? await remove(q, dataDir) : await upload(req, q, dataDir, ip);
    if (code >= 400 && !out.docs) out.docs = 'https://' + deploys.DOMAIN + '/deploy';
    return json(code, out);
  } catch (e) {
    console.error('sites api:', e.status || '', e.message);
    const code = e.status || 502;
    return json(code, { error: code === 502 ? 'Coolify said: ' + e.message : e.message, docs: 'https://' + deploys.DOMAIN + '/deploy' });
  }
}

// folder for <name>, if an uploaded site exists
function siteRoot(dataDir, name) {
  const dir = path.join(sitesDir(dataDir), name);
  return /^[a-z0-9-]+$/.test(name) && fs.existsSync(path.join(dir, 'index.html')) ? dir : null;
}

module.exports = { handle, siteRoot, usage };
