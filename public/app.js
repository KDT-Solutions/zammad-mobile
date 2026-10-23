// Zammad Mobile – Frontend ohne Build-Schritt.
// Alle Zammad-Aufrufe laufen über den eigenen Server (/api/z/...), der den Token des Benutzers hält.

const BASE = location.pathname.replace(/\/[^/]*$/, '');
const app = document.getElementById('app');
const toastEl = document.getElementById('toast');

const state = {
  user: null,
  config: null,
  overviews: [],
  currentView: localStorage.getItem('zm.view') || '',
  lookups: null,
  unread: [],          // ungelesene Online-Benachrichtigungen
  signatures: new Map(),
};

// ---------- Hilfen ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function store(k, v) { try { localStorage.setItem(k, v); } catch { /* egal */ } }

class ApiError extends Error {
  constructor(msg, status, data) { super(msg); this.status = status; this.data = data; }
}

async function api(method, path, body) {
  const opts = { method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
  if (method !== 'GET') opts.headers['X-ZM'] = '1';
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(BASE + '/api/' + path, opts);
  let data = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('json')) data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && data?.reauth && path !== 'login') {
      state.user = null;
      render();
    }
    const msg = data?.error_human || data?.error || `Fehler ${res.status}`;
    throw new ApiError(msg, res.status, data);
  }
  return data;
}
const z = (method, path, body) => api(method, 'z/' + path, body);

let toastTimer;
function toast(msg, isError = false) {
  toastEl.textContent = msg;
  toastEl.className = isError ? 'error' : '';
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, isError ? 6000 : 2500);
}

const ICON = {
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/></svg>',
  clip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
};

const STATE_DE = {
  new: 'Neu',
  open: 'Offen',
  closed: 'Geschlossen',
  'pending reminder': 'Warten auf Erinnerung',
  'pending close': 'Warten auf Schliessen',
  merged: 'Zusammengeführt',
  removed: 'Entfernt',
};
const stateLabel = (n) => STATE_DE[n] || n || '';
function stateClass(name, escalated) {
  if (escalated) return 'st-esc';
  if (name === 'new') return 'st-new';
  if (name === 'open') return 'st-open';
  if (/^pending/.test(name || '')) return 'st-pending';
  return 'st-closed';
}

const TYPE_DE = {
  email: 'E-Mail', note: 'Notiz', phone: 'Telefon', web: 'Web', sms: 'SMS',
  'whatsapp message': 'WhatsApp', 'telegram personal-message': 'Telegram',
  'facebook feed post': 'Facebook', 'twitter status': 'X', chat: 'Chat',
};
const NOTIF_DE = {
  create: 'Neues Ticket', update: 'Aktualisiert', reminder_reached: 'Erinnerung erreicht',
  escalation: 'Eskaliert', escalation_warning: 'Eskaliert bald',
};

function rel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'jetzt';
  if (diff < 3600) return `${Math.floor(diff / 60)} min`;
  if (diff < 86400 && d.getDate() === new Date().getDate()) return d.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });
  if (diff < 7 * 86400) return d.toLocaleDateString('de-CH', { weekday: 'short' });
  return d.toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: '2-digit' });
}
function abs(iso) {
  return iso ? new Date(iso).toLocaleString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
}
const userName = (u) => (u ? [u.firstname, u.lastname].filter(Boolean).join(' ') || u.email || u.login : '');

// ---------- Stammdaten ----------

async function loadLookups() {
  if (state.lookups) return state.lookups;
  // Zammad hat keine REST-Endpunkte für Artikeltypen und -absender. Deren Namen kommen
  // pro Ticket aus ticket_articles/by_ticket?expand=true (siehe learnArticleNames).
  const states = await z('GET', 'ticket_states').catch(() => []);
  const byId = (arr) => Object.fromEntries((Array.isArray(arr) ? arr : []).map((x) => [x.id, x]));
  state.lookups = {
    states: byId(states),
    statesList: (Array.isArray(states) ? states : []).filter((s) => s.active !== false),
    types: {},
    senders: {},
  };
  return state.lookups;
}

function findState(name) {
  return state.lookups?.statesList.find((s) => s.name === name);
}

async function refreshUnread() {
  try {
    const list = await z('GET', 'online_notifications?expand=true');
    state.unread = (Array.isArray(list) ? list : []).filter((n) => !n.seen);
  } catch { state.unread = []; }
  const badge = document.querySelector('[data-badge]');
  if (badge) {
    badge.textContent = state.unread.length;
    badge.hidden = !state.unread.length;
  }
  if ('setAppBadge' in navigator) {
    (state.unread.length ? navigator.setAppBadge(state.unread.length) : navigator.clearAppBadge()).catch(() => {});
  }
}

async function markTicketSeen(ticketId) {
  const hits = state.unread.filter((n) => n.o_id === Number(ticketId));
  if (!hits.length) return;
  await Promise.all(hits.map((n) => z('PUT', `online_notifications/${n.id}`, { seen: true }).catch(() => {})));
  state.unread = state.unread.filter((n) => n.o_id !== Number(ticketId));
  refreshUnread();
}

// ---------- Rahmen ----------

function shell(active, title, inner, opts = {}) {
  const nav = [
    ['#/', 'list', 'Tickets'],
    ['#/suche', 'search', 'Suche'],
    ['#/meldungen', 'bell', 'Meldungen'],
    ['#/einstellungen', 'gear', 'Einstellungen'],
  ];
  return `
    <div class="screen">
      <header class="topbar">
        ${opts.back ? `<a class="icon-btn" href="${opts.back}" aria-label="Zurück">${ICON.back}</a>` : ''}
        <h1>${esc(title)}</h1>
        ${opts.right || ''}
      </header>
      <main>${inner}</main>
      <nav class="bottomnav" aria-label="Navigation">
        ${nav.map(([href, icon, label]) => `
          <a href="${href}" ${active === href ? 'aria-current="page"' : ''}>${ICON[icon]}<span>${label}</span>
            ${icon === 'bell' ? `<span class="badge" data-badge ${state.unread.length ? '' : 'hidden'}>${state.unread.length}</span>` : ''}
          </a>`).join('')}
      </nav>
    </div>`;
}

// ---------- Login ----------

function renderLogin(mode = 'password', error = null) {
  document.body.classList.add('no-nav');
  app.innerHTML = `
    <div class="screen">
      <div class="login">
        <form id="loginForm" autocomplete="on" novalidate>
          <h1>Zammad Mobile</h1>
          <p>${mode === 'token' ? 'Mit einem persönlichen Zammad-Token anmelden.' : 'Mit deinem Zammad-Konto anmelden.'}</p>
          ${mode === 'token' ? `
            <label class="f">Token
              <input name="token" type="password" autocomplete="off" required autofocus>
            </label>
            <p class="hint">In Zammad unter Profil &gt; Token-Zugriff erstellen, mit der Berechtigung „ticket.agent“.</p>
          ` : `
            <label class="f">Benutzername oder E-Mail
              <input name="login" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus>
            </label>
            <label class="f">Passwort
              <input name="password" type="password" autocomplete="current-password" required>
            </label>
          `}
          ${error ? `<div class="err">${esc(error.error)}${error.hint ? `<br><span class="hint">${esc(error.hint)}</span>` : ''}</div>` : ''}
          <button class="btn primary" type="submit">Anmelden</button>
          <button class="linkbtn" type="button" id="switchMode">${mode === 'token' ? 'Mit Passwort anmelden' : 'Mit Token anmelden'}</button>
        </form>
      </div>
    </div>`;
  const form = document.getElementById('loginForm');
  document.getElementById('switchMode').onclick = () => renderLogin(mode === 'token' ? 'password' : 'token');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.textContent = 'Anmelden…';
    const fd = new FormData(form);
    try {
      const r = await api('POST', 'login', Object.fromEntries(fd));
      state.user = r.user;
      document.body.classList.remove('no-nav');
      if (location.hash !== '#/') location.hash = '#/'; else render();
      afterLogin();
    } catch (err) {
      const data = err.data || { error: err.message };
      renderLogin(data.tokenRequired && mode === 'password' ? 'token' : mode, data);
    }
  };
}

// ---------- Ticketliste ----------

// Zeilen aus normalisierten Tickets (vom Server: /api/overview, /api/search)
function ticketRows(rows) {
  const unreadIds = new Set(state.unread.map((n) => n.o_id));
  return rows.map((t) => {
    const st = t.state || state.lookups?.states[t.state_id]?.name || '';
    const escalated = t.escalation_at && new Date(t.escalation_at) < new Date() && !/closed|merged/.test(st);
    const when = t.last_contact_customer_at && t.last_contact_customer_at > (t.last_contact_agent_at || '') ? t.last_contact_customer_at : t.updated_at;
    return `
      <li class="trow ${stateClass(st, escalated)} ${unreadIds.has(t.id) ? 'unread' : ''}">
        <a href="#/t/${t.id}">
          <span class="stripe" aria-hidden="true"></span>
          <span class="title">${esc(t.title)}</span>
          <span class="when">${esc(rel(when))}</span>
          <span class="meta"><span class="nr">#${esc(t.number)}</span> ${esc(t.customer)}${t.group ? ` – ${esc(t.group)}` : ''}${t.owner ? ` – ${esc(t.owner)}` : ''}${escalated ? ' – eskaliert' : ` – ${esc(stateLabel(st))}`}</span>
        </a>
      </li>`;
  }).join('');
}

// Endlos-Liste: lädt die nächste Seite, sobald das Listenende in Sicht kommt
function pagedList(container, fetchPage, emptyText) {
  let next = undefined; // undefined = erste Seite, null = fertig
  let loading = false;
  let total = 0;
  let shown = 0;
  container.innerHTML = '<ul class="tlist"></ul><div class="pager"><div class="loading">Lade Tickets…</div></div>';
  const ul = container.querySelector('ul');
  const pager = container.querySelector('.pager');
  const token = {};
  container._token = token;

  const load = async () => {
    if (loading || next === null || container._token !== token) return;
    loading = true;
    pager.innerHTML = '<div class="loading">Lade…</div>';
    try {
      const r = await fetchPage(next);
      if (container._token !== token) return;
      total = r.total ?? total;
      shown += r.tickets.length;
      ul.insertAdjacentHTML('beforeend', ticketRows(r.tickets));
      next = r.next ?? null;
      if (!shown) pager.innerHTML = `<div class="empty">${esc(emptyText)}</div>`;
      else if (next === null) pager.innerHTML = total > shown ? `<p class="empty">${shown} von ${total} angezeigt</p>` : '';
      else pager.innerHTML = `<button class="more" type="button">Weitere laden (${shown} von ${total})</button>`;
      pager.querySelector('.more')?.addEventListener('click', load);
    } catch (err) {
      if (container._token !== token) return;
      pager.innerHTML = `<div class="error-box">${esc(err.message)}</div><button class="more" type="button">Nochmals versuchen</button>`;
      pager.querySelector('.more').addEventListener('click', load);
    } finally {
      loading = false;
    }
  };

  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      if (container._token !== token || !container.isConnected) { io.disconnect(); return; }
      if (entries.some((e) => e.isIntersecting)) load();
    }, { rootMargin: '600px 0px' });
    io.observe(pager);
  }
  load();
}

async function renderList() {
  document.body.classList.remove('no-nav');
  app.innerHTML = shell('#/', 'Tickets', '<div class="loading">Lade Übersichten…</div>', {
    right: `<button class="icon-btn" id="reload" aria-label="Aktualisieren">${ICON.refresh}</button>`,
  });
  document.getElementById('reload').onclick = () => renderList();
  try {
    await loadLookups();
    const ov = await z('GET', 'ticket_overviews');
    state.overviews = Array.isArray(ov) ? ov : [];
  } catch (err) {
    app.querySelector('main').innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
    return;
  }
  if (!state.overviews.length) {
    app.querySelector('main').innerHTML = '<div class="empty">In Zammad sind für dich keine Übersichten freigegeben.</div>';
    return;
  }
  if (!state.overviews.some((o) => o.link === state.currentView)) state.currentView = state.overviews[0].link;

  const main = app.querySelector('main');
  main.innerHTML = `
    <div class="views" role="tablist">
      ${state.overviews.map((o) => `
        <button type="button" data-view="${esc(o.link)}" aria-pressed="${o.link === state.currentView}">
          ${esc(o.name)}<span class="count">${o.count ?? ''}</span>
        </button>`).join('')}
    </div>
    <div id="listBody"></div>`;
  main.querySelectorAll('[data-view]').forEach((b) => {
    b.onclick = () => {
      state.currentView = b.dataset.view;
      store('zm.view', state.currentView);
      main.querySelectorAll('[data-view]').forEach((x) => x.setAttribute('aria-pressed', x === b));
      window.scrollTo(0, 0);
      loadOverview();
    };
  });
  main.querySelector('[aria-pressed="true"]')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  loadOverview();
}

function loadOverview() {
  const body = document.getElementById('listBody');
  if (!body) return;
  const ov = state.overviews.find((o) => o.link === state.currentView);
  if (!ov) return;
  pagedList(body, async (cursor) => {
    const qs = new URLSearchParams({ link: ov.link, size: '40' });
    if (ov.id) qs.set('id', ov.id);
    if (cursor) qs.set('cursor', cursor);
    const r = await api('GET', `overview?${qs}`);
    return { tickets: r.tickets, total: r.total, next: r.cursor };
  }, 'Keine Tickets in dieser Übersicht.');
}

// ---------- Suche ----------

let searchTimer;
function renderSearch() {
  const last = sessionStorage.getItem('zm.q') || '';
  app.innerHTML = shell('#/suche', 'Suche', `
    <form class="searchbar" id="sf"><input type="search" name="q" placeholder="Nummer, Titel, Kunde, Text…" value="${esc(last)}" enterkeyhint="search" autocapitalize="none"></form>
    <div id="results">${last ? '' : '<div class="empty">Suche in allen Tickets, auf die du Zugriff hast.</div>'}</div>`);
  const input = app.querySelector('input[name=q]');
  const run = () => {
    const q = input.value.trim();
    sessionStorage.setItem('zm.q', q);
    const out = document.getElementById('results');
    if (q.length < 2) { out._token = null; out.innerHTML = '<div class="empty">Mindestens 2 Zeichen eingeben.</div>'; return; }
    pagedList(out, async (page) => {
      const r = await api('GET', `search?q=${encodeURIComponent(q)}&page=${page || 1}`);
      return { tickets: r.tickets, total: r.total, next: r.nextPage };
    }, 'Nichts gefunden.');
  };
  app.querySelector('#sf').onsubmit = (e) => { e.preventDefault(); input.blur(); run(); };
  input.oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(run, 450); };
  if (last) run(); else input.focus();
}

// ---------- Meldungen ----------

async function renderNotifications() {
  app.innerHTML = shell('#/meldungen', 'Meldungen', '<div class="loading">Lade…</div>', {
    right: '<button class="btn" id="allRead">Alle gelesen</button>',
  });
  document.getElementById('allRead').onclick = async () => {
    try {
      await z('POST', 'online_notifications/mark_all_as_read', {});
      toast('Alle Meldungen als gelesen markiert');
      await refreshUnread();
      renderNotifications();
    } catch (err) { toast(err.message, true); }
  };
  try {
    const [list, full] = await Promise.all([
      z('GET', 'online_notifications?expand=true'),
      z('GET', 'online_notifications?full=true'),
    ]);
    const tickets = full?.assets?.Ticket || {};
    const users = full?.assets?.User || {};
    const items = (Array.isArray(list) ? list : []).filter((n) => !n.object || n.object === 'Ticket').slice(0, 100);
    state.unread = items.filter((n) => !n.seen);
    const main = app.querySelector('main');
    main.innerHTML = items.length ? `<ul class="nlist">${items.map((n) => {
      const t = tickets[n.o_id];
      const by = users[n.created_by_id];
      return `<li class="${n.seen ? '' : 'unseen'}"><a href="#/t/${n.o_id}">
        <div class="what">${esc(NOTIF_DE[n.type] || 'Meldung')}${by ? ` von ${esc(userName(by))}` : ''} – ${esc(rel(n.created_at))}</div>
        <div class="t">${t ? `#${esc(t.number)} ${esc(t.title)}` : `Ticket ${esc(n.o_id)}`}</div>
      </a></li>`;
    }).join('')}</ul>` : '<div class="empty">Keine Meldungen.</div>';
  } catch (err) {
    app.querySelector('main').innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
  }
}

// ---------- Ticketansicht ----------

let ticketCtx = null;

function sanitize(html) {
  const blocked = { n: 0 };
  if (!window.DOMPurify) return { html: esc(html), blocked: 0 };
  const purify = window.DOMPurify;
  purify.removeAllHooks();
  purify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
    if (node.tagName === 'IMG') {
      const src = node.getAttribute('src') || '';
      const m = src.match(/(?:^|\/)api\/v1\/ticket_attachment\/(\d+\/\d+\/\d+.*)$/);
      if (m) node.setAttribute('src', `${BASE}/api/z/ticket_attachment/${m[1]}`);
      else if (!/^data:image\//.test(src)) { node.remove(); blocked.n++; }
      node.removeAttribute('srcset');
      node.setAttribute('loading', 'lazy');
    }
    // Externe Hintergrundbilder (Tracking) entfernen
    if (node.hasAttribute && node.hasAttribute('style') && /url\(/i.test(node.getAttribute('style'))) {
      node.setAttribute('style', node.getAttribute('style').replace(/url\([^)]*\)/gi, 'none'));
    }
    node.removeAttribute?.('background');
  });
  const clean = purify.sanitize(html, {
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'select', 'textarea', 'iframe', 'object', 'embed', 'svg', 'math', 'video', 'audio', 'link', 'meta', 'base'],
    FORBID_ATTR: ['id', 'class', 'width', 'height'],
    ALLOW_DATA_ATTR: false,
  });
  return { html: clean, blocked: blocked.n };
}

function textToHtml(text) {
  return esc(text).split(/\n/).map((l) => `<div>${l || '<br>'}</div>`).join('');
}

function articleHtml(a, ctx) {
  const L = state.lookups;
  const sender = L.senders[a.sender_id]?.name || a.sender || '';
  const type = L.types[a.type_id]?.name || a.type || '';
  const author = ctx.users[a.created_by_id];
  const cls = a.internal ? 'internal' : sender === 'Agent' ? 'agent' : sender === 'System' ? 'system' : 'customer';
  let who = sender === 'Customer' ? (a.from || userName(author)) : userName(author) || a.from || '';
  who = who.replace(/<[^>]*>/g, '').replace(/"/g, '').trim();

  let body;
  let blocked = 0;
  if ((a.content_type || '').includes('html')) {
    const s = sanitize(a.body || '');
    body = s.html;
    blocked = s.blocked;
  } else {
    body = textToHtml(a.body || '');
  }
  // Inline-Bilder (im Text eingebettet) nicht nochmals als Anhang auflisten
  const atts = (a.attachments || []).filter((x) => {
    const p = x.preferences || {};
    return !((p['Content-ID'] || p['content-id']) && /inline/i.test(p['Content-Disposition'] || ''));
  });
  const typeLabel = TYPE_DE[type] || type;
  return `
    <article class="art ${cls}" data-art="${a.id}">
      <header><b>${esc(who || sender)}</b><span>${esc(abs(a.created_at))}</span><span class="kind">${a.internal ? 'Interne Notiz' : esc(typeLabel)}</span></header>
      ${a.to && sender === 'Agent' && !a.internal && type === 'email' ? `<div class="blocked">An: ${esc(a.to)}</div>` : ''}
      <div class="body">${body}</div>
      ${blocked ? `<div class="blocked">${blocked} externe${blocked === 1 ? 's Bild' : ' Bilder'} blockiert</div>` : ''}
      ${atts.length ? `<div class="atts">${atts.map((x) => `<a href="${BASE}/api/z/ticket_attachment/${a.ticket_id}/${a.id}/${x.id}?disposition=attachment" target="_blank" rel="noopener">${esc(x.filename)} <small>${Math.max(1, Math.round((x.size || 0) / 1024))} KB</small></a>`).join('')}</div>` : ''}
    </article>`;
}

function replyTarget(ctx) {
  // Antwortkanal = Kanal der letzten Kundennachricht; sonst E-Mail an den Kunden
  const L = state.lookups;
  const customerArts = ctx.articles.filter((a) => (L.senders[a.sender_id]?.name || a.sender) === 'Customer' && !a.internal);
  const last = customerArts[customerArts.length - 1];
  const lastType = last ? (L.types[last.type_id]?.name || last.type) : null;
  const customer = ctx.users[ctx.ticket.customer_id];
  // Kanal unbekannt: lieber blockieren als still per E-Mail antworten
  const unknown = ctx.articles.some((a) => !(L.senders[a.sender_id]?.name || a.sender) || !(L.types[a.type_id]?.name || a.type));
  if (unknown) return { type: null, to: '', label: 'unbekannt', html: false, last, unknown: true };
  const messaging = ['whatsapp message', 'sms', 'telegram personal-message'];
  if (last && messaging.includes(lastType)) {
    return { type: lastType, to: last.from || '', label: TYPE_DE[lastType] || lastType, html: false, last };
  }
  const to = (last && lastType === 'email' && (last.reply_to || last.from)) || customer?.email || '';
  return { type: 'email', to, label: 'E-Mail', html: true, last };
}

let meFull = null;
async function loadMe() {
  if (!meFull) meFull = await z('GET', 'users/me').catch(() => null);
  return meFull || {};
}

// Signatur der Ticket-Gruppe wie in der Zammad-Weboberfläche: { html, info, error }
async function groupSignature(ctx) {
  let group = ctx.groups[ctx.ticket.group_id];
  if (!group || !('signature_id' in group)) {
    group = await z('GET', `groups/${ctx.ticket.group_id}`).catch(() => group);
  }
  const groupName = group?.name || 'diese Gruppe';
  const sigId = group?.signature_id;
  if (!sigId) return { html: '', info: `Für ${groupName} ist in Zammad keine Signatur hinterlegt.` };
  if (!state.signatures.has(sigId)) {
    try {
      const sig = await z('GET', `signatures/${sigId}`);
      state.signatures.set(sigId, { body: sig?.active === false ? '' : (sig?.body || ''), name: sig?.name || '' });
    } catch (err) {
      return { html: '', error: `Signatur konnte nicht geladen werden (${err.message}).` };
    }
  }
  const sig = state.signatures.get(sigId);
  if (!sig.body) return { html: '', info: `Die Signatur von ${groupName} ist inaktiv oder leer.` };
  const me = await loadMe();
  const customer = ctx.users[ctx.ticket.customer_id] || {};
  const vars = {
    user: { ...me, fullname: userName(me) },
    ticket: { ...ctx.ticket, customer: { ...customer, fullname: userName(customer) }, group },
  };
  const html = sig.body.replace(/#\{([a-z0-9_.]+)\}/gi, (_, key) => {
    const v = key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), vars);
    return v == null || typeof v === 'object' ? '' : esc(v);
  });
  return { html: sanitize(html).html, name: sig.name };
}

async function showSignaturePreview() {
  const ctx = ticketCtx;
  const el = document.getElementById('sigInfo');
  if (!el || ctx.draft.internal || !replyTarget(ctx).html) return;
  const r = await groupSignature(ctx);
  if (ticketCtx !== ctx || !document.getElementById('sigInfo')) return;
  ctx.signature = r;
  const box = document.getElementById('sigInfo');
  if (r.html) {
    box.innerHTML = `<div class="sig-label">Signatur${r.name ? ` „${esc(r.name)}“` : ''} wird angehängt</div>`;
  } else {
    box.innerHTML = `<div class="sig-label ${r.error ? 'sig-err' : ''}">${esc(r.error || r.info)}</div>`;
  }
  box.hidden = false;
}

function learnArticleNames(list) {
  // Typ- und Absendernamen (z.B. "whatsapp message", "Customer") aus der expandierten Artikelliste
  const L = state.lookups;
  for (const a of Array.isArray(list) ? list : []) {
    if (a.type_id && a.type) L.types[a.type_id] = { id: a.type_id, name: a.type };
    if (a.sender_id && a.sender) L.senders[a.sender_id] = { id: a.sender_id, name: a.sender };
  }
}

async function renderTicket(id) {
  document.body.classList.remove('no-nav');
  app.innerHTML = `<div class="screen tview"><header class="topbar"><a class="icon-btn" href="#/" aria-label="Zurück">${ICON.back}</a><h1>Ticket</h1></header><main><div class="loading">Lade Ticket…</div></main></div>`;
  let r;
  try {
    await loadLookups();
    let expanded;
    [r, expanded] = await Promise.all([
      z('GET', `tickets/${encodeURIComponent(id)}?all=true`),
      z('GET', `ticket_articles/by_ticket/${encodeURIComponent(id)}?expand=true`),
    ]);
    learnArticleNames(expanded);
  } catch (err) {
    app.querySelector('main').innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
    return;
  }
  const A = r.assets || {};
  const ticket = A.Ticket?.[id] || A.Ticket?.[r.ticket_id];
  if (!ticket) {
    app.querySelector('main').innerHTML = '<div class="error-box">Ticket nicht gefunden oder kein Zugriff.</div>';
    return;
  }
  const articles = (r.ticket_article_ids || []).map((aid) => A.TicketArticle?.[aid]).filter(Boolean)
    .sort((a, b) => a.id - b.id);
  ticketCtx = {
    id: ticket.id, ticket, articles,
    users: A.User || {}, groups: A.Group || {},
    draft: ticketCtx?.id === ticket.id ? ticketCtx.draft : { text: sessionStorage.getItem(`zm.draft.${ticket.id}`) || '', internal: false, files: [] },
  };
  drawTicket();
  markTicketSeen(ticket.id);
}

function drawTicket() {
  const ctx = ticketCtx;
  const t = ctx.ticket;
  const L = state.lookups;
  const st = L.states[t.state_id]?.name;
  const escalated = t.escalation_at && new Date(t.escalation_at) < new Date() && !/closed|merged/.test(st || '');
  const customer = ctx.users[t.customer_id];
  const owner = t.owner_id > 1 ? ctx.users[t.owner_id] : null;
  const group = ctx.groups[t.group_id];
  const target = replyTarget(ctx);
  const closed = /closed|merged|removed/.test(st || '');
  const mine = t.owner_id === state.user.id;

  app.innerHTML = `
    <div class="screen tview">
      <header class="topbar">
        <a class="icon-btn" href="#/" id="backBtn" aria-label="Zurück">${ICON.back}</a>
        <h1><span class="nr">#${esc(t.number)}</span></h1>
        <button class="icon-btn" id="reloadT" aria-label="Aktualisieren">${ICON.refresh}</button>
        <button class="icon-btn" id="moreBtn" aria-label="Weitere Aktionen">${ICON.more}</button>
      </header>
      <main>
        <section class="thead ${stateClass(st, escalated)}">
          <h2>${esc(t.title)}</h2>
          <dl>
            <dt>Status</dt><dd><span class="state-pill">${esc(stateLabel(st))}${escalated ? ', eskaliert' : ''}</span>${t.pending_time && /^pending/.test(st) ? ` bis ${esc(abs(t.pending_time))}` : ''}</dd>
            <dt>Kunde</dt><dd>${esc(userName(customer))}${customer?.email ? ` <small>${esc(customer.email)}</small>` : ''}</dd>
            <dt>Gruppe</dt><dd>${esc(group?.name || '')}</dd>
            <dt>Besitzer</dt><dd>${owner ? esc(userName(owner)) : '<i>niemand</i>'}</dd>
          </dl>
        </section>
        <div class="actions">
          ${closed
            ? '<button class="btn" data-act="open">Wieder öffnen</button>'
            : '<button class="btn primary" data-act="close">Schliessen</button>'}
          ${mine ? '' : '<button class="btn" data-act="assign">Mir zuweisen</button>'}
          ${closed ? '' : '<button class="btn" data-act="pending">Warten…</button>'}
          <button class="btn" data-act="state">Status…</button>
        </div>
        <div class="thread">${ctx.articles.map((a) => articleHtml(a, ctx)).join('') || '<div class="empty">Keine Artikel.</div>'}</div>
      </main>
      <form class="composer ${ctx.draft.internal ? 'note' : ''}" id="composer">
        <div class="mode">
          <button type="button" data-mode="reply" aria-pressed="${!ctx.draft.internal}">Antwort (${esc(target.label)})</button>
          <button type="button" data-mode="note" aria-pressed="${ctx.draft.internal}">Interne Notiz</button>
          <span class="to">${ctx.draft.internal ? '' : `an ${esc(target.to || 'unbekannt')}`}</span>
        </div>
        <div class="row">
          <label class="icon-btn" aria-label="Datei anhängen" title="Datei anhängen">${ICON.clip}<input type="file" id="fileIn" multiple hidden></label>
          <textarea id="msg" rows="1" placeholder="${ctx.draft.internal ? 'Notiz für das Team…' : 'Antwort an den Kunden…'}">${esc(ctx.draft.text)}</textarea>
        </div>
        <div class="sig" id="sigInfo" hidden></div>
        <div class="files" id="files">${ctx.draft.files.map((f, i) => `<span data-file="${i}">${esc(f.filename)} ✕</span>`).join('')}</div>
        <div class="send-row" ${ctx.draft.text.trim() || ctx.draft.files.length ? '' : 'hidden'} id="sendRow">
          <button class="btn primary" type="submit" data-after="keep">Senden</button>
          ${closed ? '' : '<button class="btn" type="submit" data-after="close">Senden &amp; schliessen</button>'}
        </div>
      </form>
    </div>`;

  // Lange Artikel einklappen, Thread ans Ende scrollen
  app.querySelectorAll('.art .body').forEach((b) => {
    if (b.scrollHeight > 420) {
      b.classList.add('clamped');
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'expand';
      more.textContent = 'Ganze Nachricht anzeigen';
      more.onclick = () => { b.classList.remove('clamped'); more.remove(); };
      b.after(more);
    }
  });
  requestAnimationFrame(() => {
    const m = app.querySelector('.tview main');
    if (m) m.scrollTop = m.scrollHeight;
  });

  document.getElementById('reloadT').onclick = () => renderTicket(ctx.id);
  document.getElementById('backBtn').onclick = (e) => {
    if (history.length > 1) { e.preventDefault(); history.back(); }
  };
  app.querySelectorAll('[data-act]').forEach((b) => { b.onclick = () => ticketAction(b.dataset.act); });
  document.getElementById('moreBtn').onclick = () => ticketAction('more');
  wireComposer();
  showSignaturePreview();
}

function wireComposer() {
  const ctx = ticketCtx;
  const form = document.getElementById('composer');
  const ta = document.getElementById('msg');
  const sendRow = document.getElementById('sendRow');
  const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, window.innerHeight * 0.4) + 'px'; };
  grow();
  ta.oninput = () => {
    ctx.draft.text = ta.value;
    sessionStorage.setItem(`zm.draft.${ctx.id}`, ta.value);
    sendRow.hidden = !(ta.value.trim() || ctx.draft.files.length);
    grow();
  };
  form.querySelectorAll('[data-mode]').forEach((b) => {
    b.onclick = () => {
      ctx.draft.internal = b.dataset.mode === 'note';
      drawTicket();
      document.getElementById('msg').focus();
    };
  });
  document.getElementById('fileIn').onchange = async (e) => {
    const files = [...e.target.files];
    let total = ctx.draft.files.reduce((s, f) => s + f.size, 0);
    for (const f of files) {
      total += f.size;
      if (total > 20 * 1024 * 1024) { toast('Anhänge zusammen maximal 20 MB', true); break; }
      const data = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result).split(',')[1]);
        r.onerror = rej;
        r.readAsDataURL(f);
      });
      ctx.draft.files.push({ filename: f.name, data, 'mime-type': f.type || 'application/octet-stream', size: f.size });
    }
    drawTicket();
  };
  form.querySelectorAll('[data-file]').forEach((s) => {
    s.onclick = () => { ctx.draft.files.splice(Number(s.dataset.file), 1); drawTicket(); };
  });
  form.onsubmit = async (e) => {
    e.preventDefault();
    const after = e.submitter?.dataset.after || 'keep';
    await sendArticle(after);
  };
}

async function sendArticle(after) {
  const ctx = ticketCtx;
  const text = ctx.draft.text.trim();
  if (!text && !ctx.draft.files.length) return;
  const buttons = app.querySelectorAll('#sendRow button');
  buttons.forEach((b) => { b.disabled = true; });

  try {
    const article = { ticket_id: ctx.id, internal: !!ctx.draft.internal, sender: 'Agent' };
    if (ctx.draft.internal) {
      Object.assign(article, { type: 'note', content_type: 'text/html', body: textToHtml(text) });
    } else {
      const target = replyTarget(ctx);
      if (target.unknown) throw new Error('Antwortkanal konnte nicht ermittelt werden. Bitte Ticket neu laden.');
      if (!target.to) throw new Error('Keine Empfängeradresse gefunden. Bitte in Zammad antworten.');
      if (target.html) {
        const sig = ctx.signature || await groupSignature(ctx);
        if (sig.error) throw new Error(sig.error);
        Object.assign(article, {
          type: 'email',
          to: target.to,
          subject: ctx.ticket.title,
          content_type: 'text/html',
          body: textToHtml(text) + (sig.html ? `<div><br></div><div data-signature="true" data-signature-id="${esc(ctx.groups[ctx.ticket.group_id]?.signature_id || '')}">${sig.html}</div>` : ''),
        });
        if (target.last?.message_id) article.in_reply_to = target.last.message_id;
      } else {
        Object.assign(article, { type: target.type, to: target.to, content_type: 'text/plain', body: text });
      }
    }
    if (ctx.draft.files.length) {
      article.attachments = ctx.draft.files.map(({ filename, data, 'mime-type': mime }) => ({ filename, data, 'mime-type': mime }));
    }

    const update = { id: ctx.id, article };
    if (after === 'close') {
      const closed = findState('closed');
      if (closed) update.state_id = closed.id;
    } else if (!ctx.draft.internal && state.lookups.states[ctx.ticket.state_id]?.name === 'new') {
      // Wie in der Weboberfläche: auf eine Antwort folgt "offen"
      const open = findState('open');
      if (open) update.state_id = open.id;
    }
    await z('PUT', `tickets/${ctx.id}`, update);
    sessionStorage.removeItem(`zm.draft.${ctx.id}`);
    ctx.draft = { text: '', internal: ctx.draft.internal, files: [] };
    toast(after === 'close' ? 'Gesendet und geschlossen' : ctx.draft.internal ? 'Notiz gespeichert' : 'Gesendet');
    if (after === 'close') { history.length > 1 ? history.back() : (location.hash = '#/'); return; }
    renderTicket(ctx.id);
  } catch (err) {
    toast(err.message, true);
    buttons.forEach((b) => { b.disabled = false; });
  }
}

function sheet(title, optionsHtml, onReady) {
  const wrap = document.createElement('div');
  wrap.className = 'sheet-backdrop';
  wrap.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}"><h3>${esc(title)}</h3>${optionsHtml}
    <button class="opt" data-close>Abbrechen</button></div>`;
  const close = () => wrap.remove();
  wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.closest('[data-close]')) close(); });
  document.body.appendChild(wrap);
  onReady?.(wrap, close);
}

function defaultPendingTime() {
  // Nächster Werktag 09:00
  const d = new Date();
  d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T09:00`;
}

async function updateTicket(fields, msg) {
  try {
    await z('PUT', `tickets/${ticketCtx.id}`, { id: ticketCtx.id, ...fields });
    toast(msg);
    if (fields.state_id && findState('closed')?.id === fields.state_id) {
      history.length > 1 ? history.back() : (location.hash = '#/');
      return;
    }
    renderTicket(ticketCtx.id);
  } catch (err) { toast(err.message, true); }
}

function askPending(stateObj) {
  sheet(stateLabel(stateObj.name), `
    <div class="field">
      <label class="f">Bis
        <input type="datetime-local" id="pt" value="${defaultPendingTime()}">
      </label>
      <button class="btn primary" id="ptOk">Übernehmen</button>
    </div>`, (wrap, close) => {
    wrap.querySelector('#ptOk').onclick = () => {
      const v = wrap.querySelector('#pt').value;
      if (!v) return;
      close();
      updateTicket({ state_id: stateObj.id, pending_time: new Date(v).toISOString() }, `${stateLabel(stateObj.name)} bis ${abs(new Date(v).toISOString())}`);
    };
  });
}

function ticketAction(act) {
  const L = state.lookups;
  if (act === 'close') return updateTicket({ state_id: findState('closed')?.id }, 'Geschlossen');
  if (act === 'open') return updateTicket({ state_id: findState('open')?.id }, 'Wieder geöffnet');
  if (act === 'assign') return updateTicket({ owner_id: state.user.id }, 'Dir zugewiesen');
  if (act === 'pending') {
    const p = findState('pending reminder') || L.statesList.find((s) => /^pending/.test(s.name));
    if (p) askPending(p);
    return;
  }
  if (act === 'state') {
    const list = L.statesList.filter((s) => !['merged', 'removed'].includes(s.name) && s.id !== ticketCtx.ticket.state_id);
    return sheet('Status setzen', list.map((s) => `<button class="opt ${stateClass(s.name)}" data-sid="${s.id}"><span class="state-pill">${esc(stateLabel(s.name))}</span></button>`).join(''), (wrap, close) => {
      wrap.querySelectorAll('[data-sid]').forEach((b) => {
        b.onclick = () => {
          close();
          const s = L.states[b.dataset.sid];
          if (/^pending/.test(s.name)) askPending(s);
          else updateTicket({ state_id: s.id }, `Status: ${stateLabel(s.name)}`);
        };
      });
    });
  }
  if (act === 'more') {
    const t = ticketCtx.ticket;
    return sheet(`#${t.number}`, `
      ${t.owner_id > 1 ? '<button class="opt" data-m="unassign">Besitzer entfernen</button>' : ''}
      <button class="opt" data-m="web">In Zammad öffnen</button>
      <button class="opt" data-m="copy">Ticketnummer kopieren</button>`, (wrap, close) => {
      wrap.querySelectorAll('[data-m]').forEach((b) => {
        b.onclick = async () => {
          close();
          if (b.dataset.m === 'unassign') updateTicket({ owner_id: 1 }, 'Besitzer entfernt');
          if (b.dataset.m === 'web') window.open(`/#ticket/zoom/${t.id}`, '_blank', 'noopener');
          if (b.dataset.m === 'copy') {
            try { await navigator.clipboard.writeText(String(t.number)); toast('Kopiert'); } catch { toast('Kopieren nicht möglich', true); }
          }
        };
      });
    });
  }
}

// ---------- Einstellungen & Push ----------

function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

function urlB64ToUint8Array(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function currentSubscription() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

async function enablePush() {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Benachrichtigungen wurden nicht erlaubt. In den Systemeinstellungen freigeben.');
  const reg = await navigator.serviceWorker.ready;
  if (!state.config) state.config = await api('GET', 'config');
  let sub = await reg.pushManager.getSubscription();
  const key = urlB64ToUint8Array(state.config.vapidPublicKey);
  if (sub) {
    const current = sub.options?.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null;
    if (current && current.join() !== key.join()) { await sub.unsubscribe(); sub = null; }
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await api('POST', 'push/subscribe', { subscription: sub.toJSON() });
}

async function disablePush() {
  const sub = await currentSubscription();
  if (sub) {
    await api('POST', 'push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
    await sub.unsubscribe();
  }
}

async function renderSettings() {
  const sub = await currentSubscription().catch(() => null);
  const prefs = state.user.prefs || { types: {} };
  const iosNeedsInstall = isIos() && !isStandalone();
  app.innerHTML = shell('#/einstellungen', 'Einstellungen', `
    <div class="settings">
      <h2>Angemeldet</h2>
      <section>
        <div class="item"><span>${esc(state.user.name)}<small>${esc(state.user.login)}</small></span></div>
      </section>

      <h2>Push-Benachrichtigungen</h2>
      <section>
        ${iosNeedsInstall ? `<p class="note">Auf dem iPhone kommen Pushes nur, wenn die App auf dem Home-Bildschirm liegt: in Safari auf Teilen tippen, dann „Zum Home-Bildschirm“. Danach die App von dort öffnen und hier Push einschalten.</p>` : ''}
        ${!pushSupported() && !iosNeedsInstall ? '<p class="note">Dieser Browser unterstützt keine Push-Benachrichtigungen.</p>' : ''}
        ${pushSupported() ? `
          <label class="item"><span>Auf diesem Gerät<small>${sub ? 'Aktiv' : 'Aus'}</small></span><input type="checkbox" id="pushToggle" ${sub ? 'checked' : ''}></label>
          ${sub ? '<div class="item"><span>Testmeldung senden</span><button class="btn" id="pushTest">Senden</button></div>' : ''}
        ` : ''}
      </section>

      <h2>Melden bei</h2>
      <section>
        ${Object.entries(NOTIF_DE).map(([k, label]) => `
          <label class="item"><span>${esc(label)}</span><input type="checkbox" data-pref="${k}" ${prefs.types?.[k] !== false ? 'checked' : ''}></label>`).join('')}
      </section>
      <p class="note">Gemeldet wird, was Zammad dir als Benachrichtigung zustellt. Welche Ereignisse das sind (z.B. nur eigene Tickets oder ganze Gruppen), stellst du in Zammad unter Profil &gt; Benachrichtigungen ein.</p>

      <section>
        <div class="item"><span>Abmelden</span><button class="btn danger" id="logout">Abmelden</button></div>
      </section>
      <p class="note">Version ${esc(state.config?.version || '')}</p>
    </div>`);

  const toggle = document.getElementById('pushToggle');
  if (toggle) toggle.onchange = async () => {
    toggle.disabled = true;
    try {
      if (toggle.checked) { await enablePush(); toast('Push auf diesem Gerät aktiviert'); }
      else { await disablePush(); toast('Push auf diesem Gerät deaktiviert'); }
    } catch (err) { toast(err.message, true); }
    renderSettings();
  };
  const test = document.getElementById('pushTest');
  if (test) test.onclick = async () => {
    try {
      const r = await api('POST', 'push/test', {});
      toast(r.sent ? 'Testmeldung verschickt' : 'Kein aktives Gerät gefunden', !r.sent);
    } catch (err) { toast(err.message, true); }
  };
  app.querySelectorAll('[data-pref]').forEach((cb) => {
    cb.onchange = async () => {
      try {
        const r = await api('PUT', 'prefs', { types: { [cb.dataset.pref]: cb.checked } });
        state.user.prefs = r.prefs;
      } catch (err) { toast(err.message, true); cb.checked = !cb.checked; }
    };
  });
  document.getElementById('logout').onclick = async () => {
    const s = await currentSubscription().catch(() => null);
    try { await api('POST', 'logout', { endpoint: s?.endpoint }); } catch { /* egal */ }
    if (s) await s.unsubscribe().catch(() => {});
    state.user = null;
    state.lookups = null;
    location.hash = '#/';
    render();
  };
}

// ---------- Router ----------

function render() {
  const h = location.hash || '#/';
  const m = state.user ? h.match(/^#\/t\/(\d+)/) : null;
  document.body.classList.toggle('in-ticket', !!m);
  syncViewport();
  if (!state.user) return renderLogin();
  if (m) return renderTicket(m[1]);
  if (h.startsWith('#/suche')) return renderSearch();
  if (h.startsWith('#/meldungen')) return renderNotifications();
  if (h.startsWith('#/einstellungen')) return renderSettings();
  return renderList();
}

window.addEventListener('hashchange', render);

// Sichtbare Höhe an die Ticketansicht weitergeben. iOS verkleinert bei offener Tastatur nur den
// visualViewport und verschiebt die Seite; ohne das bleibt der Antwortbereich mitten im Bild hängen.
function syncViewport() {
  const vv = window.visualViewport;
  const root = document.documentElement.style;
  root.setProperty('--vv-h', `${Math.round(vv ? vv.height : window.innerHeight)}px`);
  root.setProperty('--vv-top', `${Math.round(vv ? vv.offsetTop : 0)}px`);
  // Nach dem Schliessen der Tastatur verschobene Seite zurücksetzen
  if (document.body.classList.contains('in-ticket') && window.scrollY !== 0
      && document.activeElement?.tagName !== 'TEXTAREA') window.scrollTo(0, 0);
}
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', syncViewport);
  window.visualViewport.addEventListener('scroll', syncViewport);
}
window.addEventListener('resize', syncViewport);
window.addEventListener('orientationchange', syncViewport);
document.addEventListener('focusout', () => setTimeout(syncViewport, 50));

let unreadTimer;
function afterLogin() {
  setTimeout(takePendingOpen, 0);
  refreshUnread();
  clearInterval(unreadTimer);
  unreadTimer = setInterval(() => { if (document.visibilityState === 'visible' && state.user) refreshUnread(); }, 60000);
  // Bestehendes Push-Abo beim Server auffrischen (z.B. nach Neuinstallation des Servers)
  currentSubscription().then((sub) => {
    if (sub && Notification.permission === 'granted') api('POST', 'push/subscribe', { subscription: sub.toJSON() }).catch(() => {});
  }).catch(() => {});
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !state.user) return;
  takePendingOpen();
  refreshUnread();
  const h = location.hash || '#/';
  if ((h === '#/' || h === '') && window.scrollY < 200) loadOverview();
});

// Klick auf eine Push-Meldung, während die App offen ist
function openFromNotification(url) {
  const hash = '#' + (String(url).split('#')[1] || '/');
  document.querySelector('.sheet-backdrop')?.remove();
  // Gleiches Ticket schon offen: neu laden, damit die neue Nachricht sichtbar ist
  if (location.hash === hash) render(); else location.hash = hash;
}
navigator.serviceWorker?.addEventListener('message', (e) => {
  if (e.data?.type === 'open' && e.data.url) { clearPendingOpen(); openFromNotification(e.data.url); }
});

// Vom Service Worker abgelegtes Klick-Ziel abholen (Kaltstart, App kommt aus dem Hintergrund)
const PENDING_KEY = `${location.origin}${BASE}/__pending-open`;
function clearPendingOpen() {
  if (!('caches' in window)) return;
  caches.open('zm-pending').then((c) => c.delete(PENDING_KEY)).catch(() => {});
}
async function takePendingOpen() {
  if (!state.user || !('caches' in window)) return;
  try {
    const c = await caches.open('zm-pending');
    const r = await c.match(PENDING_KEY);
    if (!r) return;
    await c.delete(PENDING_KEY);
    const { url, ts } = await r.json();
    if (url && Date.now() - ts < 5 * 60 * 1000) openFromNotification(url);
  } catch { /* egal */ }
}
window.addEventListener('focus', takePendingOpen);
window.addEventListener('pageshow', takePendingOpen);
// Safari stellt Nachrichten vom Service Worker sonst erst nach dem Laden zu
navigator.serviceWorker?.startMessages?.();

async function boot() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register(`${BASE}/sw.js`, { scope: `${BASE}/` }).catch((e) => console.warn('SW', e));
  }
  try {
    state.config = await api('GET', 'config');
    const r = await api('GET', 'me');
    state.user = r.user;
    afterLogin();
  } catch {
    state.user = null;
  }
  render();
}

boot();
