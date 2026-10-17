// Cloudflare Worker entry point for Spaced Word Box.
// Static files in public/ are served first; anything else reaches this worker.
//
// POST   /api/auth/login   { idToken }  → verifies a Google ID token, returns { session, user }
// POST   /api/auth/logout               → ends the session
// GET    /api/me                        → current user
// GET    /api/words                     → { cards, seed, updatedAt } for the signed-in user
// PUT    /api/words        { cards, seed } → replaces the user's word list
//
// Auth: every /api call except login sends "Authorization: Bearer <session>".
// Storage (KV binding WORDS):
//   wm:sess:<session>  → { sub, email, name, picture }   (expires after 60 days)
//   wm:words:<sub>     → { cards, seed, updatedAt }

const GOOGLE_CLIENT_ID = '719116381133-drmp1g433dj5qfnhp7u5ujbichl7d0j2.apps.googleusercontent.com';
const SESSION_TTL = 60 * 60 * 24 * 60;
const MAX_BODY = 5 * 1024 * 1024;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    try {
      if (pathname === '/api/auth/login' && method === 'POST') return login(request, env);
      if (pathname === '/api/auth/logout' && method === 'POST') return logout(request, env);
      if (pathname === '/api/me' && method === 'GET') return me(request, env);
      if (pathname === '/api/words' && method === 'GET') return getWords(request, env);
      if (pathname === '/api/words' && method === 'PUT') return putWords(request, env);
      if (pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: 'Server error' }, 500);
    }
    return env.ASSETS.fetch(request);
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function bearer(request) {
  const h = request.headers.get('Authorization') || '';
  const m = h.match(/^Bearer\s+([A-Za-z0-9-]{20,64})$/);
  return m ? m[1] : null;
}

async function currentUser(request, env) {
  const sid = bearer(request);
  if (!sid) return null;
  return env.WORDS.get(`wm:sess:${sid}`, 'json').catch(() => null);
}

// ── Auth ─────────────────────────────────────────
async function login(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const idToken = body && body.idToken;
  if (!idToken || typeof idToken !== 'string') return json({ error: 'idToken required' }, 400);

  const res = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken));
  if (!res.ok) return json({ error: 'Invalid token' }, 401);
  const t = await res.json();
  if (t.aud !== GOOGLE_CLIENT_ID) return json({ error: 'Invalid audience' }, 401);
  if (t.iss !== 'accounts.google.com' && t.iss !== 'https://accounts.google.com') return json({ error: 'Invalid issuer' }, 401);
  if (Number(t.exp) * 1000 < Date.now()) return json({ error: 'Token expired' }, 401);

  const user = { sub: t.sub, email: t.email || '', name: t.name || t.email || '', picture: t.picture || '' };
  const session = crypto.randomUUID();
  await env.WORDS.put(`wm:sess:${session}`, JSON.stringify(user), { expirationTtl: SESSION_TTL });
  return json({ session, user });
}

async function logout(request, env) {
  const sid = bearer(request);
  if (sid) await env.WORDS.delete(`wm:sess:${sid}`).catch(() => {});
  return json({ ok: true });
}

async function me(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'Not signed in' }, 401);
  return json({ user });
}

// ── Words ────────────────────────────────────────
async function getWords(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'Not signed in' }, 401);
  const data = await env.WORDS.get(`wm:words:${user.sub}`, 'json').catch(() => null);
  return json(data || { cards: null, seed: 0, updatedAt: null });
}

async function putWords(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'Not signed in' }, 401);
  const text = await request.text();
  if (text.length > MAX_BODY) return json({ error: 'Word list too large' }, 413);
  let body;
  try { body = JSON.parse(text); } catch { return json({ error: 'Invalid JSON' }, 400); }
  if (!body || !Array.isArray(body.cards)) return json({ error: 'cards array required' }, 400);
  const record = { cards: body.cards, seed: Number(body.seed) || 0, updatedAt: new Date().toISOString() };
  await env.WORDS.put(`wm:words:${user.sub}`, JSON.stringify(record));
  return json({ ok: true, updatedAt: record.updatedAt });
}
