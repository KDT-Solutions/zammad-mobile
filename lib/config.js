// Konfiguration ausschliesslich über Umgebungsvariablen. Keine Defaults mit echten Daten.
import path from 'node:path';

function list(v) {
  return (v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

const base = '/' + (process.env.BASE_PATH || '/mobilenew').replace(/^\/+|\/+$/g, '');

export const config = {
  port: Number(process.env.PORT) || 8080,
  base: base === '/' ? '' : base,
  // Interne Adresse der Zammad-Instanz, z.B. http://10.0.0.5:8080
  zammadUrl: (process.env.ZAMMAD_URL || '').replace(/\/+$/, ''),
  // Optional: Host-Header, den Zammad erwartet (z.B. support.example.com)
  zammadHostHeader: process.env.ZAMMAD_HOST_HEADER || '',
  // Öffentliche URL der App inkl. Pfad, z.B. https://support.example.com/mobilenew
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
  vapidSubject: process.env.VAPID_SUBJECT || '',
  dataDir: path.resolve(process.env.DATA_DIR || './data'),
  appSecret: process.env.APP_SECRET || '',
  pollSeconds: Math.max(5, Number(process.env.POLL_SECONDS) || 15),
  sessionDays: Math.max(1, Number(process.env.SESSION_DAYS) || 90),
  // Optional: nur diese Zammad-Logins/E-Mails dürfen sich anmelden (leer = alle Agents)
  allowedLogins: list(process.env.ALLOWED_LOGINS),
  // Anzahl Proxies vor der App, deren X-Forwarded-For vertraut wird
  trustProxyHops: Number(process.env.TRUST_PROXY_HOPS ?? 1),
  maxBodyBytes: 30 * 1024 * 1024,
};

export function validateConfig() {
  const errors = [];
  if (!config.zammadUrl) errors.push('ZAMMAD_URL fehlt');
  if (config.appSecret.length < 32) errors.push('APP_SECRET fehlt oder ist kürzer als 32 Zeichen');
  if (!config.publicUrl) errors.push('PUBLIC_URL fehlt');
  return errors;
}
