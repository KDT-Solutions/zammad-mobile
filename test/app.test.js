// Integrationstest: echte App gegen den Zammad-Mock, Push-Endpunkt als lokaler HTTPS-Server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import crypto from 'node:crypto';
import { startMock } from './mock-zammad.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}/mobilenew`;
let mock, child, tmp, pushServer, pushHits = [];
let cookie = '';

async function req(method, p, body, extraHeaders = {}) {
  const headers = { Accept: 'application/json', ...extraHeaders };
  if (cookie) headers.Cookie = cookie;
  if (method !== 'GET' && !('X-ZM' in extraHeaders)) headers['X-ZM'] = '1';
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  const setCookie = r.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, headers: r.headers, data: ct.includes('json') ? await r.json() : await r.text() };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  mock = await startMock();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zm-test-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-keyout', path.join(tmp, 'k.pem'), '-out', path.join(tmp, 'c.pem')], { stdio: 'ignore' });
  pushServer = https.createServer({ key: fs.readFileSync(path.join(tmp, 'k.pem')), cert: fs.readFileSync(path.join(tmp, 'c.pem')) }, (rq, rs) => {
    const chunks = [];
    rq.on('data', (c) => chunks.push(c));
    rq.on('end', () => { pushHits.push({ headers: rq.headers, size: Buffer.concat(chunks).length }); rs.writeHead(201); rs.end(); });
  });
  await new Promise((r) => pushServer.listen(0, '127.0.0.1', r));

  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      ZAMMAD_URL: `http://127.0.0.1:${mock.port}`,
      ZAMMAD_HOST_HEADER: 'support.example.com',
      PUBLIC_URL: 'https://support.example.com/mobilenew',
      APP_SECRET: crypto.randomBytes(32).toString('hex'),
      DATA_DIR: path.join(tmp, 'data'),
      POLL_SECONDS: '5',
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
      NODE_NO_WARNINGS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.env.DEBUG && process.stdout.write(d));
  child.stderr.on('data', (d) => process.stderr.write(d));
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/healthz')).ok) break; } catch { /* startet noch */ }
    await wait(100);
  }
});

after(() => {
  child?.kill();
  mock?.server.close();
  pushServer?.close();
});

test('statische Dateien und Redirect', async () => {
  const r = await fetch(BASE, { redirect: 'manual' });
  assert.equal(r.status, 301);
  assert.equal(r.headers.get('location'), '/mobilenew/');
  const idx = await req('GET', '/');
  assert.equal(idx.status, 200);
  assert.match(idx.data, /Zammad Mobile/);
  assert.match(idx.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal((await req('GET', '/vendor/purify.js')).status, 200);
  assert.equal((await req('GET', '/sw.js')).headers.get('service-worker-allowed'), '/mobilenew/');
  assert.equal((await req('GET', '/../server.js')).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${PORT}/anderes`)).status, 404);
});

test('ohne Login kein Zugriff, CSRF-Header Pflicht', async () => {
  assert.equal((await req('GET', '/api/me')).status, 401);
  assert.equal((await req('GET', '/api/z/tickets/101')).status, 401);
  const r = await req('POST', '/api/login', { login: 'agent@example.com', password: 'geheim' }, { 'X-ZM': '' });
  assert.equal(r.status, 403);
});

test('falsches Passwort meldet Token-Hinweis', async () => {
  const r = await req('POST', '/api/login', { login: 'agent@example.com', password: 'falsch' });
  assert.equal(r.status, 401);
  assert.equal(r.data.tokenRequired, true);
});

test('Login mit Passwort erstellt App-Token, Zugriff über Proxy', async () => {
  const before = mock.tokens.size;
  const r = await req('POST', '/api/login', { login: 'agent@example.com', password: 'geheim' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.user.name, 'Alex Muster');
  assert.match(r.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Lax/);
  assert.match(r.headers.get('set-cookie'), /Path=\/mobilenew/);
  assert.equal(mock.tokens.size, before + 1);

  const ov = await req('GET', '/api/z/ticket_overviews?view=all_open');
  assert.equal(ov.status, 200);
  assert.deepEqual(ov.data.index.tickets.map((t) => t.id), [101, 102]);
  // Host-Header wird an Zammad gesetzt, Auth als Token (nie Passwort)
  const last = mock.calls.at(-1);
  assert.equal(last.host, 'support.example.com');

  const att = await fetch(BASE + '/api/z/ticket_attachment/101/1001/5', { headers: { Cookie: cookie } });
  assert.equal(att.status, 200);
  assert.equal(att.headers.get('content-type'), 'image/png');
});

test('Übersicht seitenweise per GraphQL', async () => {
  const p1 = await req('GET', '/api/overview?link=many&id=3&size=40');
  assert.equal(p1.status, 200, JSON.stringify(p1.data));
  assert.equal(p1.data.source, 'graphql');
  assert.equal(p1.data.tickets.length, 40);
  assert.equal(p1.data.total, 95);
  const gql = mock.calls.filter((c) => c.path.startsWith('/graphql')).at(-1);
  assert.equal(gql.body.variables.overviewId, 'gid://zammad/Overview/3');
  const p3 = await req('GET', `/api/overview?link=many&id=3&size=40&cursor=${encodeURIComponent(Buffer.from('80').toString('base64'))}`);
  assert.equal(p3.data.tickets.length, 15);
  assert.equal(p3.data.cursor, null);
  assert.equal(p3.data.tickets[0].title, 'Massenticket 81');
});

test('Suche seitenweise', async () => {
  const s1 = await req('GET', '/api/search?q=massen');
  assert.equal(s1.data.tickets.length, 40);
  assert.equal(s1.data.nextPage, 2);
  const s3 = await req('GET', '/api/search?q=massen&page=3');
  assert.equal(s3.data.tickets.length, 15);
  assert.equal(s3.data.nextPage, null);
  assert.match(mock.calls.at(-1).path, /page=3&per_page=40/);
});

test('Übersicht Fallback auf REST, wenn GraphQL fehlt', async () => {
  mock.state.graphqlDisabled = true;
  const p1 = await req('GET', '/api/overview?link=many&id=3&size=40');
  assert.equal(p1.data.source, 'rest');
  assert.equal(p1.data.tickets.length, 40);
  assert.equal(p1.data.cursor, '40');
  const p2 = await req('GET', '/api/overview?link=many&id=3&size=40&cursor=40');
  assert.equal(p2.data.tickets[0].title, 'Massenticket 41');
  mock.state.graphqlDisabled = false;
});

test('Proxy blockiert Token-Verwaltung und unsaubere Pfade', async () => {
  assert.equal((await req('GET', '/api/z/user_access_token')).status, 403);
  // Kodierte Punkte und Sonderzeichen landen nie ungeprüft bei Zammad
  assert.equal((await req('GET', '/api/z/tickets/%252e%252e/users')).status, 400);
  assert.equal((await req('GET', '/api/z/tickets/1%3Bx')).status, 400);
  assert.equal((await req('GET', '/api/z/tickets//1')).status, 400);
});

test('Antwort per E-Mail mit Signatur und Schliessen in einem Schritt', async () => {
  const r = await req('PUT', '/api/z/tickets/101', {
    id: 101, state_id: 4,
    article: { ticket_id: 101, type: 'email', to: 'kunde@example.org', subject: 'Test', content_type: 'text/html', body: '<div>Erledigt</div>', internal: false, sender: 'Agent' },
  });
  assert.equal(r.status, 200);
  assert.equal(mock.tickets[101].state_id, 4);
  const created = Object.values(mock.articles).find((a) => a.body === '<div>Erledigt</div>');
  assert.ok(created);
  assert.equal(created.type_id, 1);
});

test('Push: Abo, erster Lauf setzt nur die Grenze, neue Meldung wird gepusht', async () => {
  const keys = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const p256dh = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-65).toString('base64url');
  const auth = crypto.randomBytes(16).toString('base64url');
  mock.addNotification(102, 'update'); // alte Meldung vor dem Abo
  const sub = await req('POST', '/api/push/subscribe', { subscription: { endpoint: `https://127.0.0.1:${pushServer.address().port}/push/abc`, keys: { p256dh, auth } } });
  assert.equal(sub.status, 200);
  await wait(800);
  assert.equal(pushHits.length, 0, 'alte Meldung darf nicht gepusht werden');

  mock.addNotification(101, 'update');
  for (let i = 0; i < 80 && !pushHits.length; i++) await wait(100);
  assert.equal(pushHits.length, 1);
  assert.equal(pushHits[0].headers['content-encoding'], 'aes128gcm');
  assert.equal(pushHits[0].headers.urgency, 'high');
  assert.match(pushHits[0].headers.authorization, /^vapid t=/);

  const t = await req('POST', '/api/push/test', {});
  assert.equal(t.data.sent, 1);
});

test('Einstellungen speichern', async () => {
  const r = await req('PUT', '/api/prefs', { types: { update: false, foo: true } });
  assert.equal(r.data.prefs.types.update, false);
  assert.equal(r.data.prefs.types.foo, undefined);
});

test('Logout widerruft den App-Token', async () => {
  const before = mock.tokens.size;
  const r = await req('POST', '/api/logout', {});
  assert.equal(r.status, 200);
  assert.equal(mock.tokens.size, before - 1);
  assert.equal((await req('GET', '/api/me')).status, 401);
});

test('Login mit eingefügtem Token, kein Widerruf beim Logout', async () => {
  cookie = '';
  const r = await req('POST', '/api/login', { token: mock.TOKEN });
  assert.equal(r.status, 200);
  await req('POST', '/api/logout', {});
  assert.ok(mock.tokens.has(mock.TOKEN));
});
