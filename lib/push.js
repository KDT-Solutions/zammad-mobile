// Web-Push (VAPID) und Abgleich der Zammad-Online-Benachrichtigungen pro Benutzer.
import webpush from 'web-push';
import { config } from './config.js';
import { db, getMeta, setMeta, readPrefs } from './db.js';
import { decrypt } from './crypto.js';
import { zammad, tokenAuth } from './zammad.js';

let vapid;

export function initVapid() {
  let pub = getMeta('vapid_public');
  let priv = getMeta('vapid_private');
  if (!pub || !priv) {
    const keys = webpush.generateVAPIDKeys();
    pub = keys.publicKey;
    priv = keys.privateKey;
    setMeta('vapid_public', pub);
    setMeta('vapid_private', priv);
  }
  const subject = config.vapidSubject || new URL(config.publicUrl).origin;
  webpush.setVapidDetails(subject, pub, priv);
  vapid = { publicKey: pub };
  return vapid;
}

export function vapidPublicKey() {
  return vapid.publicKey;
}

export async function sendToUser(userId, payload) {
  const subs = db.prepare('SELECT * FROM subscriptions WHERE user_id = ?').all(userId);
  let sent = 0;
  for (const s of subs) {
    const sub = { endpoint: s.endpoint, keys: JSON.parse(s.keys) };
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload), {
        TTL: 6 * 3600,
        urgency: 'high',
        // Topic: gleiche Ticket-Meldungen ersetzen sich beim Push-Dienst, solange das Gerät offline ist
        topic: payload.tag ? payload.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) : undefined,
      });
      sent++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        db.prepare('DELETE FROM subscriptions WHERE endpoint = ?').run(s.endpoint);
      } else {
        console.error(`[push] Senden an User ${userId} fehlgeschlagen:`, err.statusCode || '', err.body || err.message);
      }
    }
  }
  return sent;
}

const TYPE_LABEL = {
  create: 'Neues Ticket',
  update: 'Aktualisiert',
  reminder_reached: 'Erinnerung erreicht',
  escalation: 'Eskaliert',
  escalation_warning: 'Eskaliert bald',
};

function stripHtml(html) {
  return String(html || '')
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<blockquote[\s\S]*$/i, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

async function buildPayload(auth, n) {
  const type = typeof n.type === 'string' ? n.type : '';
  const label = TYPE_LABEL[type] || 'Benachrichtigung';
  const ticketId = n.o_id;
  let title = `${label}`;
  let body = '';

  const t = await zammad({ path: `/tickets/${ticketId}?expand=true`, auth });
  if (t.status === 200 && t.data) {
    title = `${label}: ${t.data.title}`;
    const parts = [`#${t.data.number}`];
    if (t.data.customer) parts.push(t.data.customer);
    body = parts.join(' · ');

    if (type === 'create' || type === 'update') {
      const a = await zammad({ path: `/ticket_articles/by_ticket/${ticketId}?expand=true`, auth });
      if (a.status === 200 && Array.isArray(a.data) && a.data.length) {
        const last = a.data[a.data.length - 1];
        const who = (last.created_by && last.created_by !== '-') ? last.created_by : (last.from || '');
        const text = stripHtml(last.body).slice(0, 180);
        const prefix = last.internal ? 'Notiz' : (last.sender === 'Customer' ? 'Kunde' : '');
        body = [body, [prefix, who].filter(Boolean).join(' ') + (text ? `: ${text}` : '')].filter(Boolean).join('\n');
      }
    }
  }

  return {
    title,
    body,
    tag: `ticket-${ticketId}`,
    url: `${config.base}/#/t/${ticketId}`,
    ticketId,
    notificationId: n.id,
  };
}

const busy = new Set();

export async function pollUser(user) {
  if (busy.has(user.id)) return;
  busy.add(user.id);
  try {
    const auth = tokenAuth(decrypt(user.token_enc));
    const r = await zammad({ path: '/online_notifications?expand=true', auth });
    if (r.status === 401) {
      console.warn(`[poll] Token von User ${user.id} ungültig, Abos und Sessions werden entfernt`);
      db.prepare('DELETE FROM subscriptions WHERE user_id = ?').run(user.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
      return;
    }
    if (r.status !== 200 || !Array.isArray(r.data)) return;

    const all = r.data.filter((n) => Number.isInteger(n.id));
    const maxId = all.reduce((m, n) => Math.max(m, n.id), 0);

    // Erster Lauf: nur die Grenze setzen, keine alten Meldungen pushen
    if (!user.last_notif_id) {
      db.prepare('UPDATE users SET last_notif_id = ? WHERE id = ?').run(maxId || 1, user.id);
      return;
    }

    const prefs = readPrefs(user);
    const unseenCount = all.filter((n) => !n.seen).length;
    // Nur junge Meldungen pushen (z.B. nach längerer Pause kein Nachholen alter Meldungen)
    const minCreated = Date.now() - 30 * 60 * 1000;
    const fresh = all
      .filter((n) => n.id > user.last_notif_id && !n.seen)
      .filter((n) => !n.created_at || Date.parse(n.created_at) >= minCreated)
      .sort((a, b) => a.id - b.id);

    // Mehrere Meldungen zum selben Ticket in einem Durchlauf zusammenfassen
    const latestPerTicket = new Map();
    for (const n of fresh) {
      const type = typeof n.type === 'string' ? n.type : 'update';
      if (prefs.types[type] === false) continue;
      if (n.object && n.object !== 'Ticket') continue;
      latestPerTicket.set(n.o_id, n);
    }

    for (const n of latestPerTicket.values()) {
      try {
        const payload = await buildPayload(auth, n);
        payload.badge = unseenCount;
        await sendToUser(user.id, payload);
      } catch (err) {
        console.error(`[poll] Push für Meldung ${n.id} fehlgeschlagen:`, err.message);
      }
    }

    if (maxId > user.last_notif_id) {
      db.prepare('UPDATE users SET last_notif_id = ? WHERE id = ?').run(maxId, user.id);
    }
  } catch (err) {
    console.error(`[poll] User ${user.id}:`, err.message);
  } finally {
    busy.delete(user.id);
  }
}

export function startPoller() {
  const tick = async () => {
    const users = db.prepare(
      'SELECT u.* FROM users u WHERE EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id = u.id)'
    ).all();
    await Promise.all(users.map(pollUser));
  };
  setInterval(() => { tick().catch((e) => console.error('[poll]', e.message)); }, config.pollSeconds * 1000);
  tick().catch((e) => console.error('[poll]', e.message));
}
