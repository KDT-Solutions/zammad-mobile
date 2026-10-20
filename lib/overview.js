// Seitenweises Laden von Zammad-Übersichten.
// Bevorzugt die GraphQL-Abfrage ticketsByOverview (echtes Paging, wie die Zammad-Mobile-Ansicht).
// Fallback für ältere Zammad-Versionen: REST-Übersicht einmal laden, Ergebnis kurz cachen und seitenweise ausliefern.
import { zammad } from './zammad.js';

const QUERY = `
query zmOverview($overviewId: ID!, $cursor: String, $pageSize: Int) {
  ticketsByOverview(overviewId: $overviewId, after: $cursor, first: $pageSize) {
    totalCount
    edges {
      node {
        internalId
        number
        title
        updatedAt
        escalationAt
        pendingTime
        lastContactCustomerAt
        lastContactAgentAt
        customer { fullname }
        owner { internalId fullname }
        state { name }
        group { name }
      }
    }
    pageInfo { endCursor hasNextPage }
  }
}`;

function fromGraphql(node) {
  return {
    id: node.internalId,
    number: node.number,
    title: node.title,
    updated_at: node.updatedAt,
    escalation_at: node.escalationAt,
    pending_time: node.pendingTime,
    last_contact_customer_at: node.lastContactCustomerAt,
    last_contact_agent_at: node.lastContactAgentAt,
    customer: node.customer?.fullname || '',
    owner_id: node.owner?.internalId || 1,
    owner: node.owner?.internalId > 1 ? node.owner.fullname : '',
    state: node.state?.name || '',
    group: node.group?.name || '',
  };
}

const fullname = (u) => (u ? [u.firstname, u.lastname].filter(Boolean).join(' ') || u.email || u.login : '');

export function fromAssets(id, assets) {
  const t = assets.Ticket?.[id];
  if (!t) return null;
  const U = assets.User || {};
  return {
    id: t.id,
    number: t.number,
    title: t.title,
    updated_at: t.updated_at,
    escalation_at: t.escalation_at,
    pending_time: t.pending_time,
    last_contact_customer_at: t.last_contact_customer_at,
    last_contact_agent_at: t.last_contact_agent_at,
    customer: fullname(U[t.customer_id]),
    owner_id: t.owner_id,
    owner: t.owner_id > 1 ? fullname(U[t.owner_id]) : '',
    state: assets.TicketState?.[t.state_id]?.name || '',
    state_id: t.state_id,
    group: assets.Group?.[t.group_id]?.name || '',
  };
}

// Benutzer, bei denen GraphQL nicht funktioniert (alte Version, Token-Zugriff gesperrt): direkt Fallback
const graphqlBroken = new Map(); // userId -> Zeitpunkt; nach 10 Minuten neuer Versuch
const restCache = new Map(); // key -> { at, rows }
const REST_TTL_MS = 60 * 1000;

async function viaGraphql(auth, overviewId, cursor, pageSize) {
  const r = await zammad({
    method: 'POST',
    path: '/graphql',
    root: true,
    auth,
    body: {
      query: QUERY,
      variables: { overviewId: `gid://zammad/Overview/${overviewId}`, cursor: cursor || null, pageSize },
    },
  });
  if (r.status !== 200 || typeof r.data !== 'object' || r.data?.errors?.length || !r.data?.data?.ticketsByOverview) {
    const msg = r.data?.errors?.[0]?.message || `HTTP ${r.status}`;
    throw Object.assign(new Error(msg), { graphql: true });
  }
  const c = r.data.data.ticketsByOverview;
  return {
    tickets: c.edges.map((e) => fromGraphql(e.node)),
    total: c.totalCount,
    cursor: c.pageInfo.hasNextPage ? c.pageInfo.endCursor : null,
  };
}

async function viaRest(auth, userId, link, cursor, pageSize) {
  const key = `${userId}:${link}`;
  let entry = restCache.get(key);
  // Neue erste Seite: immer frisch laden, Folgeseiten aus dem Cache
  if (!entry || !cursor || Date.now() - entry.at > REST_TTL_MS) {
    const r = await zammad({ path: `/ticket_overviews?view=${encodeURIComponent(link)}`, auth });
    if (r.status !== 200) throw Object.assign(new Error(r.data?.error || `HTTP ${r.status}`), { status: r.status });
    const ids = (r.data?.index?.tickets || []).map((t) => t.id);
    const assets = r.data?.assets || {};
    entry = { at: Date.now(), rows: ids.map((id) => fromAssets(id, assets)).filter(Boolean), total: r.data?.index?.tickets_count ?? ids.length };
    restCache.set(key, entry);
  }
  const start = Number(cursor) || 0;
  const slice = entry.rows.slice(start, start + pageSize);
  const next = start + pageSize;
  return { tickets: slice, total: entry.total, cursor: next < entry.rows.length ? String(next) : null };
}

export async function loadOverviewPage({ auth, userId, overviewId, link, cursor, pageSize }) {
  if (overviewId && !(Date.now() - (graphqlBroken.get(userId) || 0) < 10 * 60 * 1000) && !(cursor && /^\d+$/.test(cursor))) {
    try {
      return { ...(await viaGraphql(auth, overviewId, cursor, pageSize)), source: 'graphql' };
    } catch (err) {
      if (!err.graphql) throw err;
      console.warn(`[overview] GraphQL nicht nutzbar (${err.message}), weiter mit REST`);
      graphqlBroken.set(userId, Date.now());
      cursor = null;
    }
  }
  return { ...(await viaRest(auth, userId, link, cursor, pageSize)), source: 'rest' };
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of restCache) if (now - v.at > REST_TTL_MS * 5) restCache.delete(k);
}, 5 * 60 * 1000).unref();
