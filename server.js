import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, validateConfig } from './lib/config.js';

const configErrors = validateConfig();
if (configErrors.length) {
  console.error('Konfigurationsfehler:\n - ' + configErrors.join('\n - '));
  process.exit(1);
}

const { db, readPrefs, DEFAULT_PREFS } = await import('./lib/db.js');
const { encrypt, decrypt, randomToken, sha256 } = await import('./lib/crypto.js');
const { zammad, zammadRaw, zammadError, tokenAuth, basicAuth } = await import('./lib/zammad.js');
const { initVapid, vapidPublicKey, sendToUser, startPoller, pollUser } = await import('./lib/push.js');
const { loadOverviewPage, fromAssets } = await import('./lib/overview.js');

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const COOKIE = 'zm_sid';
const COOKIE_PATH = config.base || '/';

initVapid();

// ---------- Hilfsfunktionen ----------

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "media-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
};

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  const payload = isJson ? JSON.stringify(body) : body;
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Cache-Control': 'no-store',
    ...(isJson ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
    ...headers,
  });
  res.end(payload);
}

function clientIp(req) {
  const xff = (req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (config.trustProxyHops > 0 && xff.length) {
    return xff[Math.max(0, xff.length - config.trustProxyHops)];
  }
  return req.socket.remoteAddress || '';
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function readBody(req, limit = config.maxBodyBytes) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('Anfrage zu gross'), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const buf = await readBody(req, 1024 * 1024);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw Object.assign(new Error('Ungültiges JSON'), { status: 400 }); }
}

function sessionCookie(value, maxAgeSec) {
  return `${COOKIE}=${encodeURIComponent(value)}; Path=${COOKIE_PATH}; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

function currentUser(req) {
  const sid = parseCookies(req)[COOKIE];
  if (!sid) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sha256(sid));
  if (!s) return null;
  if (s.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(s.id);
    return null;
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id);
  if (!user) return null;
  return { user, sessionId: s.id };
}

// Einfaches Rate-Limit für Login-Versuche (pro IP)
const loginAttempts = new Map();
function loginAllowed(ip) {
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const list = (loginAttempts.get(ip) || []).filter((t) => now - t < windowMs);
  loginAttempts.set(ip, list);
  return list.length < 10;
}
function loginFailed(ip) {
  const list = loginAttempts.get(ip) || [];
  list.push(Date.now());
  loginAttempts.set(ip, list);
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, list] of loginAttempts) {
    if (!list.some((t) => now - t < 15 * 60 * 1000)) loginAttempts.delete(ip);
  }
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
}, 10 * 60 * 1000).unref();

function publicUser(u) {
  return { id: u.id, login: u.login, name: u.name, prefs: readPrefs(u) };
}

// ---------- Login ----------

async function createAppToken(auth, ua) {
  const label = `Zammad Mobile ${new Date().toISOString().slice(0, 10)} ${randomToken(4)}`;
  const attempts = [
    ['ticket.agent', 'user_preferences.notifications'],
    ['ticket.agent'],
  ];
  let last;
  for (const permission of attempts) {
    last = await zammad({
      method: 'POST',
      path: '/user_access_token',
      auth,
      body: { name: label, label, permission, expires_at: null },
    });
    if (last.status === 200 || last.status === 201) {
      const token = last.data?.token || last.data?.name;
      if (typeof token !== 'string' || token.length < 20) break;
      // Token-ID suchen, damit sie beim Abmelden widerrufen werden kann
      let tokenId = null;
      const list = await zammad({ path: '/user_access_token', auth: tokenAuth(token) });
      const tokens = Array.isArray(list.data) ? list.data : list.data?.tokens;
      if (Array.isArray(tokens)) {
        const hit = tokens.find((t) => t.label === label || t.name === label);
        if (hit) tokenId = hit.id;
      }
      return { token, tokenId };
    }
  }
  const err = new Error(zammadError(last));
  err.status = last?.status;
  throw err;
}

async function handleLogin(req, res) {
  const ip = clientIp(req);
  if (!loginAllowed(ip)) return send(res, 429, { error: 'Zu viele Versuche. Bitte in 15 Minuten nochmals probieren.' });

  const body = await readJson(req);
  const login = String(body.login || '').trim();
  const password = String(body.password || '');
  const pastedToken = String(body.token || '').trim();

  let token;
  let tokenId = null;
  let me;

  if (pastedToken) {
    const r = await zammad({ path: '/users/me', auth: tokenAuth(pastedToken) });
    if (r.status !== 200) {
      loginFailed(ip);
      return send(res, 401, { error: 'Token ungültig oder abgelaufen.' });
    }
    me = r.data;
    token = pastedToken;
  } else {
    if (!login || !password) return send(res, 400, { error: 'Benutzername und Passwort angeben.' });
    const auth = basicAuth(login, password);
    const r = await zammad({ path: '/users/me', auth });
    if (r.status !== 200) {
      loginFailed(ip);
      return send(res, 401, {
        error: 'Anmeldung fehlgeschlagen.',
        hint: 'Falls bei dir Zwei-Faktor-Anmeldung aktiv ist oder Passwort-Zugriff auf die API gesperrt ist: in Zammad unter Profil > Token-Zugriff einen Token erstellen und hier damit anmelden.',
        tokenRequired: true,
      });
    }
    me = r.data;
    try {
      ({ token, tokenId } = await createAppToken(auth, req.headers['user-agent'] || ''));
    } catch (err) {
      return send(res, 403, {
        error: `Zammad hat keinen Token für die App ausgestellt (${err.message}).`,
        hint: 'In Zammad unter Profil > Token-Zugriff einen Token mit der Berechtigung "ticket.agent" erstellen und hier damit anmelden.',
        tokenRequired: true,
      });
    }
  }

  if (config.allowedLogins.length) {
    const ids = [me.login, me.email].filter(Boolean).map((s) => String(s).toLowerCase());
    if (!ids.some((i) => config.allowedLogins.includes(i))) {
      loginFailed(ip);
      return send(res, 403, { error: 'Dieser Benutzer ist für die App nicht freigeschaltet.' });
    }
  }

  // Agent-Prüfung: Übersichten sind nur für Agents verfügbar
  const check = await zammad({ path: '/ticket_overviews', auth: tokenAuth(token) });
  if (check.status !== 200) {
    return send(res, 403, { error: 'Die App ist nur für Zammad-Agents gedacht (Token braucht "ticket.agent").' });
  }

  const name = [me.firstname, me.lastname].filter(Boolean).join(' ') || me.login;
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(me.id);
  if (existing && existing.token_id && existing.token_id !== tokenId) {
    // Alten App-Token widerrufen, ein Benutzer hat immer nur einen aktiven App-Token
    try {
      await zammad({ method: 'DELETE', path: `/user_access_token/${existing.token_id}`, auth: tokenAuth(token) });
    } catch { /* egal */ }
  }
  db.prepare(`
    INSERT INTO users (id, login, name, token_enc, token_id, last_notif_id, prefs, updated_at)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?)
    ON CONFLICT(id) DO UPDATE SET login = excluded.login, name = excluded.name,
      token_enc = excluded.token_enc, token_id = excluded.token_id, updated_at = excluded.updated_at
  `).run(me.id, me.login, name, encrypt(token), tokenId, JSON.stringify(DEFAULT_PREFS), Date.now());

  const sid = randomToken(32);
  const maxAge = config.sessionDays * 86400;
  db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)')
    .run(sha256(sid), me.id, Date.now(), Date.now() + maxAge * 1000, String(req.headers['user-agent'] || '').slice(0, 300));

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(me.id);
  send(res, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(sid, maxAge) });
}

async function handleLogout(req, res, ctx) {
  const { user, sessionId } = ctx;
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  const body = await readJson(req).catch(() => ({}));
  if (body.endpoint) db.prepare('DELETE FROM subscriptions WHERE endpoint = ? AND user_id = ?').run(body.endpoint, user.id);

  // Letzte Session des Benutzers: App-Token in Zammad widerrufen und Daten entfernen
  const left = db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE user_id = ?').get(user.id).c;
  if (left === 0) {
    if (user.token_id) {
      try {
        await zammad({ method: 'DELETE', path: `/user_access_token/${user.token_id}`, auth: tokenAuth(decrypt(user.token_enc)) });
      } catch (err) {
        console.warn('[logout] Token konnte nicht widerrufen werden:', err.message);
      }
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  }
  send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
}

// ---------- Zammad-Proxy ----------

const PROXY_PATH = /^[A-Za-z0-9_\-/.]+$/;

async function handleProxy(req, res, ctx, subPath, search) {
  if (!PROXY_PATH.test(subPath) || subPath.includes('..') || subPath.includes('//')) {
    return send(res, 400, { error: 'Ungültiger Pfad' });
  }
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(req.method)) return send(res, 405, { error: 'Methode nicht erlaubt' });
  // Token-Verwaltung nur über die App selbst, nicht über den Proxy
  if (/^user_access_token/.test(subPath)) return send(res, 403, { error: 'Nicht erlaubt' });

  let body;
  const headers = {};
  if (req.method !== 'GET' && req.method !== 'DELETE') {
    body = await readBody(req);
    headers['Content-Type'] = req.headers['content-type'] || 'application/json';
  }
  const upstream = await zammadRaw({
    method: req.method,
    path: '/' + subPath + (search || ''),
    auth: tokenAuth(decrypt(ctx.user.token_enc)),
    headers,
    body,
  });

  if (upstream.statusCode === 401) {
    upstream.resume();
    return send(res, 401, { error: 'Zammad-Token ungültig. Bitte neu anmelden.', reauth: true });
  }

  const out = { ...SECURITY_HEADERS, 'Cache-Control': 'private, no-store' };
  for (const h of ['content-type', 'content-length', 'content-disposition', 'etag', 'last-modified']) {
    if (upstream.headers[h]) out[h] = upstream.headers[h];
  }
  // Anhänge nie als HTML im App-Kontext ausliefern
  if (/^ticket_attachment\//.test(subPath)) {
    const ct = String(out['content-type'] || '');
    if (/html|xml|svg|javascript/i.test(ct)) {
      out['content-type'] = 'application/octet-stream';
      out['content-disposition'] = 'attachment';
    }
    out['Content-Security-Policy'] = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox";
    out['Cache-Control'] = 'private, max-age=3600';
  }
  res.writeHead(upstream.statusCode, out);
  upstream.pipe(res);
}

// ---------- Übersichten und Suche (seitenweise) ----------

async function handleOverview(req, res, ctx, url) {
  const link = url.searchParams.get('link') || '';
  const overviewId = Number(url.searchParams.get('id')) || null;
  const cursor = url.searchParams.get('cursor') || null;
  const pageSize = Math.min(100, Math.max(10, Number(url.searchParams.get('size')) || 40));
  if (!/^[A-Za-z0-9_-]+$/.test(link)) return send(res, 400, { error: 'Ungültige Übersicht' });
  const page = await loadOverviewPage({
    auth: tokenAuth(decrypt(ctx.user.token_enc)), userId: ctx.user.id, overviewId, link, cursor, pageSize,
  });
  send(res, 200, page);
}

async function handleSearch(req, res, ctx, url) {
  const q = (url.searchParams.get('q') || '').trim().slice(0, 200);
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const perPage = 40;
  if (q.length < 2) return send(res, 400, { error: 'Suchbegriff zu kurz' });
  const r = await zammad({
    path: `/tickets/search?query=${encodeURIComponent(q)}&page=${page}&per_page=${perPage}&limit=${perPage}&sort_by=updated_at&order_by=desc&full=true`,
    auth: tokenAuth(decrypt(ctx.user.token_enc)),
  });
  if (r.status === 401) return send(res, 401, { error: 'Zammad-Token ungültig. Bitte neu anmelden.', reauth: true });
  if (r.status !== 200) return send(res, r.status, { error: zammadError(r) });
  const ids = r.data?.record_ids || r.data?.tickets || [];
  const total = r.data?.total_count ?? r.data?.tickets_count ?? ids.length;
  const tickets = ids.map((id) => fromAssets(id, r.data?.assets || {})).filter(Boolean);
  send(res, 200, { tickets, total, nextPage: ids.length >= perPage && page * perPage < total ? page + 1 : null });
}

// ---------- Push-API ----------

async function handlePushSubscribe(req, res, ctx) {
  const body = await readJson(req);
  const sub = body.subscription || body;
  if (!sub?.endpoint || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) {
    return send(res, 400, { error: 'Ungültige Subscription' });
  }
  db.prepare(`
    INSERT INTO subscriptions (endpoint, user_id, keys, user_agent, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, keys = excluded.keys, user_agent = excluded.user_agent
  `).run(sub.endpoint, ctx.user.id, JSON.stringify({ p256dh: sub.keys.p256dh, auth: sub.keys.auth }),
    String(req.headers['user-agent'] || '').slice(0, 300), Date.now());
  // Grenze sofort setzen, damit nach dem Abo keine alten Meldungen kommen
  pollUser(db.prepare('SELECT * FROM users WHERE id = ?').get(ctx.user.id));
  send(res, 200, { ok: true });
}

async function handlePushUnsubscribe(req, res, ctx) {
  const body = await readJson(req);
  if (body.endpoint) db.prepare('DELETE FROM subscriptions WHERE endpoint = ? AND user_id = ?').run(body.endpoint, ctx.user.id);
  send(res, 200, { ok: true });
}

async function handlePushTest(req, res, ctx) {
  const n = await sendToUser(ctx.user.id, {
    title: 'Testmeldung',
    body: 'Push-Benachrichtigungen funktionieren.',
    tag: 'test',
    url: `${config.base}/#/`,
  });
  send(res, 200, { sent: n });
}

async function handlePrefs(req, res, ctx) {
  const body = await readJson(req);
  const prefs = readPrefs(ctx.user);
  if (body.types && typeof body.types === 'object') {
    for (const k of Object.keys(prefs.types)) {
      if (typeof body.types[k] === 'boolean') prefs.types[k] = body.types[k];
    }
  }
  db.prepare('UPDATE users SET prefs = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(prefs), Date.now(), ctx.user.id);
  send(res, 200, { prefs });
}

// ---------- Statische Dateien ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const STATIC_EXTRA = {
  '/vendor/purify.js': path.join(ROOT, 'node_modules/dompurify/dist/purify.min.js'),
};

function serveStatic(req, res, rel) {
  if (rel === '/' || rel === '') rel = '/index.html';
  let file = STATIC_EXTRA[rel];
  if (!file) {
    const resolved = path.normalize(path.join(PUBLIC, rel));
    if (!resolved.startsWith(PUBLIC + path.sep)) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
    file = resolved;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
    const ext = path.extname(file);
    const noCache = ['.html', '.webmanifest'].includes(ext) || rel === '/sw.js';
    const headers = {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': noCache ? 'no-cache' : 'public, max-age=300',
    };
    if (rel === '/sw.js') headers['Service-Worker-Allowed'] = (config.base || '') + '/';
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

// ---------- Router ----------

async function route(req, res) {
  const url = new URL(req.url, 'http://local');
  let p = url.pathname;

  if (p === '/healthz' || p === `${config.base}/healthz`) return send(res, 200, { ok: true, version: VERSION });

  if (config.base) {
    if (p === config.base) return send(res, 301, '', { Location: config.base + '/' });
    if (!p.startsWith(config.base + '/')) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
    p = p.slice(config.base.length);
  }

  if (!p.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Methode nicht erlaubt' });
    return serveStatic(req, res, p);
  }

  // CSRF-Schutz: schreibende Requests nur mit eigenem Header (setzt der Browser bei Cross-Site nicht)
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-zm'] !== '1') {
    return send(res, 403, { error: 'CSRF-Prüfung fehlgeschlagen' });
  }

  if (p === '/api/login' && req.method === 'POST') return handleLogin(req, res);
  if (p === '/api/config' && req.method === 'GET') {
    return send(res, 200, { version: VERSION, vapidPublicKey: vapidPublicKey() });
  }

  const ctx = currentUser(req);
  if (!ctx) return send(res, 401, { error: 'Nicht angemeldet', reauth: true });

  if (p === '/api/me' && req.method === 'GET') return send(res, 200, { user: publicUser(ctx.user) });
  if (p === '/api/logout' && req.method === 'POST') return handleLogout(req, res, ctx);
  if (p === '/api/push/subscribe' && req.method === 'POST') return handlePushSubscribe(req, res, ctx);
  if (p === '/api/push/unsubscribe' && req.method === 'POST') return handlePushUnsubscribe(req, res, ctx);
  if (p === '/api/push/test' && req.method === 'POST') return handlePushTest(req, res, ctx);
  if (p === '/api/prefs' && req.method === 'PUT') return handlePrefs(req, res, ctx);
  if (p === '/api/overview' && req.method === 'GET') return handleOverview(req, res, ctx, url);
  if (p === '/api/search' && req.method === 'GET') return handleSearch(req, res, ctx, url);
  if (p.startsWith('/api/z/')) return handleProxy(req, res, ctx, p.slice('/api/z/'.length), url.search);

  send(res, 404, { error: 'Unbekannter Endpunkt' });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    const status = err.status || 502;
    if (status >= 500) console.error('[http]', req.method, req.url.split('?')[0], err.message);
    if (!res.headersSent) send(res, status, { error: status === 502 ? 'Zammad nicht erreichbar' : err.message });
    else res.destroy();
  });
});

server.headersTimeout = 30000;
server.requestTimeout = 120000;

server.listen(config.port, () => {
  console.log(`zammad-mobile ${VERSION} läuft auf Port ${config.port}, Pfad ${config.base || '/'}`);
  startPoller();
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close();
    try { db.close(); } catch { /* egal */ }
    process.exit(0);
  });
}
