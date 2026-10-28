// Self-serve deploys for build.happyoperators.com.
// Anyone with the access code can point a public GitHub repo at
// <name>.build.happyoperators.com. Talks to the Coolify API on the same box.
//
//   GET  /api/deploys                 -> { enabled, needsCode, apps: [{ name, url, repo }] }
//   POST /api/deploys                 { name, repo, branch, port, pack, code } -> { name, url, deployment }
//   GET  /api/deploys/status/<uuid>   -> { status, log: [lines] }
//
// Env (not COOLIFY_URL: Coolify sets that to the app's own address):
//   COOLIFY_API_URL      default http://178.104.187.207:8000 (this server's Coolify)
//   COOLIFY_TOKEN        Coolify API token (Keys & Tokens). Deploys are off without it.
//   COOLIFY_SERVER_UUID  server to deploy onto (default: first server)
//   DEPLOY_PROJECT       Coolify project for these apps (default "Deploys", created if missing)
//   DEPLOY_CODE          access code people must enter (recommended)
//   DEPLOY_DOMAIN        default build.happyoperators.com
//   DEPLOY_MAX_APPS      default 40

const COOLIFY_URL = (process.env.COOLIFY_API_URL || 'http://178.104.187.207:8000').replace(/\/$/, '');
const TOKEN = process.env.COOLIFY_TOKEN || '';
const DOMAIN = process.env.DEPLOY_DOMAIN || 'build.happyoperators.com';
const PROJECT_NAME = process.env.DEPLOY_PROJECT || 'Deploys';
const CODE = process.env.DEPLOY_CODE || '';
const MAX_APPS = Number(process.env.DEPLOY_MAX_APPS) || 40;

const RESERVED = new Set(['www', 'api', 'app', 'admin', 'build', 'deploy', 'deploys', 'coolify', 'mail', 'smtp', 'ftp', 'status', 'dashboard', 'test']);
const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/;
const REPO_RE = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;
const BRANCH_RE = /^[A-Za-z0-9._\/-]{1,100}$/;
const PACKS = { auto: 'nixpacks', dockerfile: 'dockerfile', static: 'static' };

// ---------- Coolify API ----------
async function api(method, path, body) {
  const res = await fetch(COOLIFY_URL + '/api/v1' + path, {
    method: method,
    headers: {
      Authorization: 'Bearer ' + TOKEN,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = { message: text.slice(0, 300) }; }
  if (!res.ok) {
    const err = new Error((data && (data.message || data.error)) || ('Coolify ' + res.status));
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

let ids = null; // { project, server }, looked up once
async function target() {
  if (ids) return ids;
  const projects = await api('GET', '/projects');
  let project = (projects || []).find((p) => p.name === PROJECT_NAME);
  if (!project) project = await api('POST', '/projects', { name: PROJECT_NAME, description: 'Apps deployed from ' + DOMAIN });
  let server = process.env.COOLIFY_SERVER_UUID;
  if (!server) {
    const servers = await api('GET', '/servers');
    server = servers && servers[0] && servers[0].uuid;
  }
  if (!project || !project.uuid || !server) throw new Error('Could not find a Coolify project or server');
  ids = { project: project.uuid, server: server };
  return ids;
}

function urlFor(name) { return 'https://' + name + '.' + DOMAIN; }

// apps living at <name>.DOMAIN, keyed by name
async function liveApps() {
  const apps = await api('GET', '/applications');
  const re = new RegExp('^https://([a-z0-9-]+)\\.' + DOMAIN.replace(/\./g, '\\.') + '/?$');
  const out = new Map();
  for (const a of apps || []) {
    for (const d of String(a.fqdn || '').split(',')) {
      const m = d.trim().match(re);
      if (m) out.set(m[1], { uuid: a.uuid, repo: a.git_repository || '', status: a.status || '' });
    }
  }
  return out;
}

function sameRepo(a, b) {
  const norm = (s) => String(s || '').toLowerCase().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
  return norm(a) === norm(b);
}

// ---------- rate limit: 10 deploys per IP per hour ----------
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 3600000);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return arr.length > 10;
}

// ---------- handlers ----------
async function list() {
  if (!TOKEN) return { enabled: false, needsCode: !!CODE, apps: [] };
  const apps = await liveApps();
  return {
    enabled: true,
    needsCode: !!CODE,
    apps: [...apps].map(([name, a]) => ({ name: name, url: urlFor(name), repo: a.repo, status: a.status }))
      .sort((x, y) => x.name.localeCompare(y.name))
  };
}

async function deploy(body, ip) {
  if (!TOKEN) return [503, { error: 'Deploys are not switched on yet.' }];
  if (CODE && String(body.code || '').trim() !== CODE) return [403, { error: 'That access code is not right.' }];
  if (limited(ip)) return [429, { error: 'Too many deploys from one address. Try again in an hour.' }];

  const name = String(body.name || '').trim().toLowerCase();
  if (!NAME_RE.test(name)) return [400, { error: 'Name must be 3 to 30 characters: lowercase letters, numbers and dashes.' }];
  if (RESERVED.has(name)) return [400, { error: 'That name is reserved. Pick another.' }];

  const m = String(body.repo || '').trim().match(REPO_RE);
  if (!m) return [400, { error: 'Paste a public GitHub link like https://github.com/you/your-app' }];
  const repo = 'https://github.com/' + m[1] + '/' + m[2];

  const branch = String(body.branch || 'main').trim() || 'main';
  if (!BRANCH_RE.test(branch)) return [400, { error: 'That branch name looks wrong.' }];

  const pack = PACKS[body.pack] ? body.pack : 'auto';
  const port = pack === 'static' ? 80 : Number(body.port || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return [400, { error: 'Port must be a number, usually 3000.' }];

  // repo must exist and be public
  const gh = await fetch('https://api.github.com/repos/' + m[1] + '/' + m[2], { headers: { 'User-Agent': DOMAIN } });
  if (gh.status === 404) return [400, { error: 'Cannot see that repo. Is it public?' }];

  const apps = await liveApps();
  const existing = apps.get(name);
  let uuid;
  if (existing) {
    if (!sameRepo(existing.repo, repo)) return [409, { error: name + '.' + DOMAIN + ' is taken by another repo. Pick another name.' }];
    uuid = existing.uuid; // same repo: just redeploy
  } else {
    if (apps.size >= MAX_APPS) return [409, { error: 'The server is full right now. Ask Matt to make room.' }];
    const t = await target();
    const created = await api('POST', '/applications/public', {
      project_uuid: t.project,
      server_uuid: t.server,
      environment_name: 'production',
      name: name,
      description: 'Deployed from ' + DOMAIN + ' form',
      git_repository: repo,
      git_branch: branch,
      build_pack: PACKS[pack],
      is_static: pack === 'static',
      ports_exposes: String(port),
      domains: urlFor(name),
      limits_memory: '512m',
      limits_cpus: '0.5',
      instant_deploy: false
    });
    uuid = created.uuid;
  }

  const queued = await api('POST', '/deploy?uuid=' + encodeURIComponent(uuid));
  const d = queued && queued.deployments && queued.deployments[0];
  return [200, { name: name, url: urlFor(name), redeploy: !!existing, deployment: d ? d.deployment_uuid : null }];
}

async function status(uuid) {
  const d = await api('GET', '/deployments/' + encodeURIComponent(uuid));
  let lines = [];
  try {
    lines = JSON.parse(d.logs || '[]')
      .filter((l) => !l.hidden)
      .map((l) => String(l.output || '').trim())
      .filter(Boolean);
  } catch (e) { lines = []; }
  return { status: d.status, log: lines.slice(-40) };
}

// returns true if it handled the request
async function handle(req, res, p, send, readBody) {
  if (!p.startsWith('/api/deploys')) return false;
  const ip = ((req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '';
  const json = (code, obj) => { send(res, code, JSON.stringify(obj)); return true; };
  try {
    if (p === '/api/deploys' && req.method === 'GET') return json(200, await list());
    if (p === '/api/deploys' && req.method === 'POST') {
      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch (e) { return json(400, { error: 'Bad request' }); }
      const [code, out] = await deploy(body, ip);
      return json(code, out);
    }
    const s = p.match(/^\/api\/deploys\/status\/([a-z0-9]+)$/);
    if (s && req.method === 'GET') return json(200, await status(s[1]));
    return json(404, { error: 'Not found' });
  } catch (e) {
    console.error('deploy api:', e.status || '', e.message);
    return json(502, { error: 'Coolify said: ' + e.message });
  }
}

module.exports = { handle };
