// Kleiner Zammad-Mock für lokale Tests. Bildet nur die Endpunkte nach, die die App nutzt.
import http from 'node:http';

export function startMock(port = 0) {
  const TOKEN = 'mock-token-0123456789abcdef0123';
  const tokens = new Map([[TOKEN, { id: 1, label: 'pasted' }]]);
  let nextTokenId = 10;
  const me = { id: 7, login: 'agent@example.com', firstname: 'Alex', lastname: 'Muster', email: 'agent@example.com' };
  const customer = { id: 20, login: 'kunde@example.org', firstname: 'Kim', lastname: 'Kunde', email: 'kunde@example.org' };
  const states = [
    { id: 1, name: 'new', active: true }, { id: 2, name: 'open', active: true },
    { id: 3, name: 'pending reminder', active: true }, { id: 4, name: 'closed', active: true },
    { id: 5, name: 'merged', active: true }, { id: 7, name: 'pending close', active: true },
  ];
  const types = [{ id: 1, name: 'email' }, { id: 10, name: 'note' }, { id: 15, name: 'whatsapp message' }];
  const senders = [{ id: 1, name: 'Agent' }, { id: 2, name: 'Customer' }, { id: 3, name: 'System' }];
  const group = { id: 3, name: 'Support', signature_id: 1 };
  const tickets = {
    101: { id: 101, number: '2740001', title: 'Drucker im Büro druckt nicht', state_id: 1, group_id: 3, customer_id: 20, owner_id: 1, updated_at: new Date(Date.now() - 600000).toISOString() },
    102: { id: 102, number: '2740002', title: 'WhatsApp-Anfrage Schloss', state_id: 2, group_id: 3, customer_id: 20, owner_id: 7, updated_at: new Date(Date.now() - 86400000).toISOString() },
  };
  const articles = {
    1001: { id: 1001, ticket_id: 101, sender_id: 2, type_id: 1, from: 'Kim Kunde <kunde@example.org>', to: 'support@example.com', internal: false, content_type: 'text/html', message_id: '<abc@example.org>', body: '<p>Hallo, der Drucker geht nicht.</p><img src="https://tracker.example.net/p.gif"><img src="/api/v1/ticket_attachment/101/1001/5"><script>alert(1)</script><a href="https://example.org" onclick="x()">Link</a>', attachments: [{ id: 5, filename: 'foto.png', size: 2048, preferences: { 'Content-Type': 'image/png' } }], created_by_id: 20, created_at: new Date(Date.now() - 600000).toISOString() },
    1002: { id: 1002, ticket_id: 102, sender_id: 2, type_id: 15, from: '+41790000000', internal: false, content_type: 'text/plain', body: 'Hallo, welches Schloss passt?', attachments: [], created_by_id: 20, created_at: new Date(Date.now() - 86400000).toISOString() },
  };
  let nextArt = 2000;
  const state = { graphqlDisabled: false };
  const bulk = {};
  for (let i = 0; i < 95; i++) {
    const id = 5000 + i;
    bulk[id] = { id, number: String(3000000 + i), title: `Massenticket ${i + 1}`, state_id: 4, group_id: 3, customer_id: 20, owner_id: 1, updated_at: new Date(Date.now() - i * 3600000).toISOString() };
  }
  const notifications = [];
  const calls = [];

  function authUser(req) {
    const a = req.headers.authorization || '';
    if (a.startsWith('Token token=')) return tokens.has(a.slice(12)) ? me : null;
    if (a.startsWith('Basic ')) {
      const [l, p] = Buffer.from(a.slice(6), 'base64').toString().split(':');
      return l === me.login && p === 'geheim' ? me : null;
    }
    return null;
  }

  const ticketAssets = (ids) => ({
    Ticket: Object.fromEntries(ids.map((i) => [i, tickets[i]])),
    User: { 7: me, 20: customer },
    Group: { 3: group },
    TicketState: Object.fromEntries(states.map((s) => [s.id, s])),
  });

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? JSON.parse(raw) : null;
    const url = new URL(req.url, 'http://x');
    const p = url.pathname.replace(/^\/api\/v1/, '');
    calls.push({ method: req.method, path: p + url.search, body, host: req.headers.host });
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };

    const user = authUser(req);
    if (!user) return json(401, { error: 'authentication failed' });

    if (p === '/users/me') return json(200, user);
    if (p === '/user_access_token' && req.method === 'POST') {
      if (!(req.headers.authorization || '').startsWith('Basic')) return json(403, { error: 'not allowed' });
      const t = 'apptoken-' + Math.random().toString(36).slice(2) + 'xxxxxxxxxxxxxxxx';
      tokens.set(t, { id: nextTokenId++, label: body.label });
      return json(200, { token: t });
    }
    if (p === '/user_access_token' && req.method === 'GET') {
      return json(200, { tokens: [...tokens.values()].map((t) => ({ id: t.id, label: t.label })) });
    }
    const del = p.match(/^\/user_access_token\/(\d+)$/);
    if (del && req.method === 'DELETE') {
      for (const [k, v] of tokens) if (v.id === Number(del[1])) tokens.delete(k);
      return json(200, {});
    }
    if (p === '/ticket_overviews' && !url.searchParams.get('view')) {
      return json(200, [{ id: 1, name: 'Meine Tickets', link: 'my_assigned', prio: 1, count: 1 }, { id: 2, name: 'Offene Tickets', link: 'all_open', prio: 2, count: 2 }, { id: 3, name: 'Viele Tickets', link: 'many', prio: 3, count: 95 }]);
    }
    if (p === '/ticket_overviews') {
      const view = url.searchParams.get('view');
      if (view === 'many') {
        const ids = Object.keys(bulk).map(Number);
        return json(200, { assets: { ...ticketAssets([]), Ticket: bulk }, index: { tickets: ids.map((id) => ({ id })), tickets_count: ids.length } });
      }
      const ids = view === 'my_assigned' ? [102] : [101, 102];
      return json(200, { assets: ticketAssets(ids), index: { tickets: ids.map((id) => ({ id })), tickets_count: ids.length } });
    }
    if (p === '/tickets/search') {
      const page = Number(url.searchParams.get('page')) || 1;
      const per = Number(url.searchParams.get('per_page')) || 50;
      const ids = Object.keys(bulk).map(Number).slice((page - 1) * per, page * per);
      return json(200, { record_ids: ids, total_count: Object.keys(bulk).length, assets: { ...ticketAssets([]), Ticket: bulk } });
    }
    if (url.pathname === '/graphql') {
      if (state.graphqlDisabled) return json(200, { errors: [{ message: "Field 'ticketsByOverview' doesn't exist" }] });
      const v = body.variables;
      const oid = Number(String(v.overviewId).split('/').pop());
      const all = oid === 3 ? Object.values(bulk) : oid === 1 ? [tickets[102]] : [tickets[101], tickets[102]];
      const start = v.cursor ? Number(Buffer.from(v.cursor, 'base64').toString()) : 0;
      const slice = all.slice(start, start + v.pageSize);
      const end = start + slice.length;
      return json(200, { data: { ticketsByOverview: {
        totalCount: all.length,
        edges: slice.map((t) => ({ node: {
          internalId: t.id, number: t.number, title: t.title, updatedAt: t.updated_at, escalationAt: null, pendingTime: null,
          lastContactCustomerAt: null, lastContactAgentAt: null,
          customer: { fullname: 'Kim Kunde' }, owner: { internalId: t.owner_id, fullname: t.owner_id === 7 ? 'Alex Muster' : '-' },
          state: { name: states.find((x) => x.id === t.state_id).name }, group: { name: 'Support' },
        } })),
        pageInfo: { endCursor: Buffer.from(String(end)).toString('base64'), hasNextPage: end < all.length },
      } } });
    }
    const gm = p.match(/^\/groups\/(\d+)$/);
    if (gm) return json(200, group);
    const tm = p.match(/^\/tickets\/(\d+)$/);
    if (tm && req.method === 'GET') {
      const t = tickets[tm[1]];
      if (!t) return json(404, { error: 'not found' });
      if (url.searchParams.get('expand')) return json(200, { ...t, customer: customer.email });
      const arts = Object.values(articles).filter((a) => a.ticket_id === t.id);
      return json(200, {
        ticket_id: t.id,
        ticket_article_ids: arts.map((a) => a.id),
        assets: { ...ticketAssets([t.id]), TicketArticle: Object.fromEntries(arts.map((a) => [a.id, a])) },
      });
    }
    if (tm && req.method === 'PUT') {
      const t = tickets[tm[1]];
      if (body.state_id) t.state_id = body.state_id;
      if (body.owner_id) t.owner_id = body.owner_id;
      if (body.pending_time) t.pending_time = body.pending_time;
      if (body.article) {
        const typeId = types.find((x) => x.name === body.article.type)?.id;
        const id = nextArt++;
        articles[id] = { id, ticket_id: t.id, sender_id: 1, type_id: typeId, internal: !!body.article.internal, content_type: body.article.content_type, body: body.article.body, to: body.article.to, attachments: [], created_by_id: 7, created_at: new Date().toISOString() };
      }
      t.updated_at = new Date().toISOString();
      return json(200, t);
    }
    const bt = p.match(/^\/ticket_articles\/by_ticket\/(\d+)$/);
    if (bt) return json(200, Object.values(articles).filter((a) => a.ticket_id === Number(bt[1])).map((a) => ({ ...a, sender: senders.find((s) => s.id === a.sender_id).name, created_by: a.created_by_id === 20 ? customer.email : me.email })));
    if (p === '/ticket_states') return json(200, states);
    if (p === '/ticket_article_types') return json(200, types);
    if (p === '/ticket_article_senders') return json(200, senders);
    if (p === '/signatures/1') return json(200, { id: 1, active: true, body: '<div>Freundliche Grüsse<br>#{user.firstname} #{user.lastname}<br>#{ticket.group.name}</div>' });
    if (p === '/online_notifications') {
      if (url.searchParams.get('full')) return json(200, { record_ids: notifications.map((n) => n.id), assets: ticketAssets([101, 102]) });
      return json(200, notifications);
    }
    const on = p.match(/^\/online_notifications\/(\d+)$/);
    if (on && req.method === 'PUT') { const n = notifications.find((x) => x.id === Number(on[1])); if (n) n.seen = true; return json(200, n || {}); }
    if (p === '/online_notifications/mark_all_as_read') { notifications.forEach((n) => { n.seen = true; }); return json(200, {}); }
    const att = p.match(/^\/ticket_attachment\/(\d+)\/(\d+)\/(\d+)$/);
    if (att) {
      // 1x1 PNG
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length });
      return res.end(png);
    }
    json(404, { error: `mock: ${req.method} ${p} unbekannt` });
  });

  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    resolve({
      server, port: server.address().port, TOKEN, state, tokens, tickets, articles, notifications, calls,
      addNotification(o_id, type = 'update') {
        const id = (notifications.at(-1)?.id || 500) + 1;
        notifications.push({ id, o_id, object: 'Ticket', type, seen: false, created_by_id: 20, created_at: new Date().toISOString() });
        return id;
      },
    });
  }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const m = await startMock(Number(process.env.MOCK_PORT) || 4010);
  console.log('Mock läuft auf', m.port);
  setInterval(() => m.addNotification(101, 'update'), 3600000);
}
