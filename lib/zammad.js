// Minimaler Zammad-REST-Client über node:http(s), damit Host-Header und Streaming frei steuerbar sind.
import http from 'node:http';
import https from 'node:https';
import { config } from './config.js';

const TIMEOUT_MS = 30000;

export function tokenAuth(token) {
  return `Token token=${token}`;
}

export function basicAuth(login, password) {
  return 'Basic ' + Buffer.from(`${login}:${password}`, 'utf8').toString('base64');
}

// Roh-Request: liefert die IncomingMessage (für Streaming, z.B. Anhänge).
export function zammadRaw({ method = 'GET', path, auth, headers = {}, body }) {
  const url = new URL(config.zammadUrl + '/api/v1' + path);
  const lib = url.protocol === 'https:' ? https : http;
  const h = {
    Accept: 'application/json',
    'X-Forwarded-Proto': 'https',
    ...headers,
  };
  if (auth) h.Authorization = auth;
  if (config.zammadHostHeader) h.Host = config.zammadHostHeader;
  if (body !== undefined && body !== null) {
    if (!Buffer.isBuffer(body)) {
      body = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
      h['Content-Type'] = h['Content-Type'] || 'application/json';
    }
    h['Content-Length'] = body.length;
  }
  return new Promise((resolve, reject) => {
    const req = lib.request(url, { method, headers: h, timeout: TIMEOUT_MS }, resolve);
    req.on('timeout', () => req.destroy(new Error('Zammad-Timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// JSON-Request: liefert { status, data }.
export async function zammad(opts) {
  const res = await zammadRaw(opts);
  const chunks = [];
  for await (const c of res) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8');
  let data = text;
  if ((res.headers['content-type'] || '').includes('json')) {
    try { data = JSON.parse(text); } catch { /* Rohtext behalten */ }
  }
  return { status: res.statusCode, data, headers: res.headers };
}

export function zammadError(r) {
  if (r && typeof r.data === 'object' && r.data) {
    return r.data.error_human || r.data.error || r.data.message || `HTTP ${r.status}`;
  }
  return `HTTP ${r?.status}`;
}
