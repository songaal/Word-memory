import { FREQ_WORDS } from './freq.js';
// Cloudflare Worker entry point for Word Story.
// Static files in public/ are served first; anything else reaches this worker.
//
// POST   /api/auth/login   { idToken }  → verifies a Google ID token, returns { session, user }
// POST   /api/auth/logout               → ends the session
// GET    /api/me                        → current user
// GET    /api/words                     → { cards, seed, updatedAt } for the signed-in user
// PUT    /api/words        { cards, seed, log, history, stories } → replaces the user's word list, answer log, test history, and stories
// GET    /api/lookup?word=              → dictionary entry (no sign-in needed)
// GET/PUT/DELETE /api/video/transcript?v=   GET/PUT /api/video/translations?v=   GET/PUT /api/video/history  (signed in)
// GET    /api/settings                  → { translateKey, aiProvider, openaiKey/Model, geminiKey/Model, claudeKey/Model } for the signed-in user
// PUT    /api/settings     { translateKey, aiProvider, openaiKey/Model, geminiKey/Model, claudeKey/Model } → saves the user's settings
//
// Auth: /api/me and /api/words send "Authorization: Bearer <session>".
// Storage (KV binding WORDS):
//   wm:sess:<session>  → { sub, email, name, picture }   (expires after 60 days)
//   wm:words:<sub>     → { cards, seed, log, history, stories, updatedAt }
//   wm:settings:<sub>  → { translateKey, aiProvider, openaiKey/Model, geminiKey/Model, claudeKey/Model }   (the user's own Google Translate / OpenAI keys)
//   wm:email:<email>   → the Google account behind that address (set at Google sign-in / app start)
//   wm:totp:<sub>      → authenticator-app secret {secret, lastStep, created}; wm:totpPending:<sub> during setup;
//   wm:totpTry:<email> → wrong sign-in tries (10 minutes)
//   wm:journal:<sub>   → journal entries (merged per entry on save)
//   wm:dict3:<word>    → cached dictionary entry (90 days; "not found" for 1 day)
//   wm:vt:<videoId>    → video transcript {sentences:[{text,start,end}], source} (shared by video, 1 year)
//   wm:vtr:<videoId>   → Korean translations of that transcript {index: text} (1 year)
//   wm:vhist:<sub>     → the user's recent videos [{videoId, title, date, s}] (newest first, max 100)
//   Video data from the old video-repeat-player app (KV binding VIDEO_CACHE, read only, optional):
//   <videoId> → transcript, tr:<videoId> → translations, hist:<email> → history
//
// Dictionary: Merriam-Webster only (keys are Worker secrets, never in the repo).
//   Learner's  (MW_LEARNER_KEY)   — definitions, example sentences, pronunciation
//   Thesaurus  (MW_THESAURUS_KEY) — similar words
//   Similar words: at most 3, the most common ones from the thesaurus's main meaning (FREQ_WORDS); none if MW has none.

const GOOGLE_CLIENT_ID = '719116381133-drmp1g433dj5qfnhp7u5ujbichl7d0j2.apps.googleusercontent.com';
const SESSION_TTL = 60 * 60 * 24 * 60;
const MAX_BODY = 5 * 1024 * 1024;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    try {
      if (pathname === '/api/auth/login' && method === 'POST') return await login(request, env);
      if (pathname === '/api/auth/logout' && method === 'POST') return await logout(request, env);
      if (pathname === '/api/auth/totp' && method === 'POST') return await totpLogin(request, env);
      if (pathname === '/api/totp' && method === 'GET') return await totpStatus(request, env);
      if (pathname === '/api/totp/setup' && method === 'POST') return await totpSetup(request, env);
      if (pathname === '/api/totp/confirm' && method === 'POST') return await totpConfirm(request, env);
      if (pathname === '/api/totp' && method === 'DELETE') return await totpOff(request, env);
      if (pathname === '/api/me' && method === 'GET') return await me(request, env);
      if (pathname === '/api/words' && method === 'GET') return await getWords(request, env);
      if (pathname === '/api/words' && method === 'PUT') return await putWords(request, env);
      if (pathname === '/api/lookup' && method === 'GET') return await lookup(url, env);
      if (pathname === '/api/journal' && method === 'GET') return await getJournal(request, env);
      if (pathname === '/api/journal' && method === 'PUT') return await putJournal(request, env);
      if (pathname.startsWith('/api/video/')) return await video(request, env, url);
      if (pathname === '/api/settings' && method === 'GET') return await getSettings(request, env);
      if (pathname === '/api/settings' && method === 'PUT') return await putSettings(request, env);
      if (pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: 'Server error', detail: String(e && e.message || e).slice(0, 200) }, 500);
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
  await linkEmail(env, user);
  return json({ session: await newSession(env, user), user });
}
async function newSession(env, user) {
  const session = crypto.randomUUID();
  await env.WORDS.put(`wm:sess:${session}`, JSON.stringify(user), { expirationTtl: SESSION_TTL });
  return session;
}
// Authenticator sign-in works only for addresses that signed in with Google before: email → that Google account
async function linkEmail(env, user) {
  if (!user || !user.email) return;
  const k = `wm:email:${user.email.toLowerCase()}`;
  const cur = await env.WORDS.get(k, 'json').catch(() => null);
  if (!cur || cur.sub !== user.sub || cur.name !== user.name || cur.picture !== user.picture)
    await env.WORDS.put(k, JSON.stringify(user));
}

// ── Authenticator-app sign-in (TOTP, RFC 6238: 6 digits, 30 s, SHA-1 — Authy, Google Authenticator…) ──
// Set up while signed in with Google: wm:totpPending:<sub> (15 min) → confirmed with a code → wm:totp:<sub> {secret, lastStep, created}.
// Sign-in: email (must have signed in with Google: wm:email:<email>) + current code; ±1 step for clock drift;
// a used step can't be reused; 5 wrong tries per email per 10 minutes (wm:totpTry:<email>).
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const normEmail = e => String(e || '').trim().toLowerCase();
function b32encode(bytes) {
  let bits = 0, val = 0, out = '';
  for (const b of bytes) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function b32decode(str) {
  let bits = 0, val = 0; const out = [];
  for (const c of str.replace(/=+$/, '').toUpperCase()) { const i = B32.indexOf(c); if (i < 0) continue; val = (val << 5) | i; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  return new Uint8Array(out);
}
async function totpAt(secret, step) {
  const key = await crypto.subtle.importKey('raw', b32decode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const msg = new ArrayBuffer(8); const dv = new DataView(msg);
  dv.setUint32(0, Math.floor(step / 2 ** 32)); dv.setUint32(4, step >>> 0);
  const h = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const o = h[19] & 15;
  const n = ((h[o] & 127) << 24 | h[o + 1] << 16 | h[o + 2] << 8 | h[o + 3]) % 1000000;
  return String(n).padStart(6, '0');
}
// returns the matching step (or 0) within ±1 step of now
async function totpCheck(secret, code, now = Date.now()) {
  code = String(code || '').replace(/\D/g, '');
  if (code.length !== 6) return 0;
  const cur = Math.floor(now / 30000);
  for (const st of [cur, cur - 1, cur + 1]) if (await totpAt(secret, st) === code) return st;
  return 0;
}
async function totpStatus(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'Not signed in' }, 401);
  const t = await env.WORDS.get(`wm:totp:${user.sub}`, 'json').catch(() => null);
  return json({ enabled: !!t, created: t ? t.created : null, email: user.email || '' });
}
async function totpSetup(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'Not signed in' }, 401);
  if (!user.email) return json({ error: 'noemail' }, 400);
  const secret = b32encode(crypto.getRandomValues(new Uint8Array(20)));
  await env.WORDS.put(`wm:totpPending:${user.sub}`, JSON.stringify({ secret }), { expirationTtl: 900 });
  const label = encodeURIComponent('Word Story:' + user.email);
  return json({ secret, uri: `otpauth://totp/${label}?secret=${secret}&issuer=Word%20Story&algorithm=SHA1&digits=6&period=30` });
}
async function totpConfirm(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'Not signed in' }, 401);
  let body; try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const pend = await env.WORDS.get(`wm:totpPending:${user.sub}`, 'json').catch(() => null);
  if (!pend) return json({ error: 'expired' }, 400);
  const st = await totpCheck(pend.secret, body && body.code);
  if (!st) return json({ error: 'wrong' }, 400);
  await env.WORDS.put(`wm:totp:${user.sub}`, JSON.stringify({ secret: pend.secret, lastStep: st, created: new Date().toISOString() }));
  await env.WORDS.delete(`wm:totpPending:${user.sub}`);
  await linkEmail(env, user);
  return json({ ok: true });
}
async function totpOff(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'Not signed in' }, 401);
  await env.WORDS.delete(`wm:totp:${user.sub}`);
  return json({ ok: true });
}
async function totpLogin(request, env) {
  let body; try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const email = normEmail(body && body.email);
  if (!email || email.length > 120) return json({ error: 'invalid' }, 400);
  const tk = `wm:totpTry:${email}`;
  const tries = await env.WORDS.get(tk, 'json').catch(() => null);
  if (tries && tries.n >= 5) return json({ error: 'locked' }, 429);
  const user = await env.WORDS.get(`wm:email:${email}`, 'json').catch(() => null);
  const t = user ? await env.WORDS.get(`wm:totp:${user.sub}`, 'json').catch(() => null) : null;
  const st = t ? await totpCheck(t.secret, body && body.code) : 0;
  if (!t || !st || st <= (t.lastStep || 0)) {
    const n = (tries ? tries.n : 0) + 1;
    await env.WORDS.put(tk, JSON.stringify({ n }), { expirationTtl: 600 });
    return json({ error: !t ? 'notset' : st && st <= (t.lastStep || 0) ? 'used' : 'wrong', left: Math.max(0, 5 - n) }, 400);
  }
  t.lastStep = st;
  await env.WORDS.put(`wm:totp:${user.sub}`, JSON.stringify(t));
  if (tries) await env.WORDS.delete(tk);
  return json({ session: await newSession(env, user), user });
}

async function logout(request, env) {
  const sid = bearer(request);
  if (sid) await env.WORDS.delete(`wm:sess:${sid}`).catch(() => {});
  return json({ ok: true });
}

async function me(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'Not signed in' }, 401);
  await linkEmail(env, user).catch(() => {});   // users who signed in with Google before this existed get linked too
  return json({ user });
}

// ── Words ────────────────────────────────────────
async function getWords(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'Not signed in' }, 401);
  const data = await env.WORDS.get(`wm:words:${user.sub}`, 'json').catch(() => null);
  return json(data || { cards: null, seed: 0, log: {}, history: [], stories: [], updatedAt: null });
}

async function putWords(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'Not signed in' }, 401);
  const text = await request.text();
  if (text.length > MAX_BODY) return json({ error: 'Word list too large' }, 413);
  let body;
  try { body = JSON.parse(text); } catch { return json({ error: 'Invalid JSON' }, 400); }
  if (!body || !Array.isArray(body.cards)) return json({ error: 'cards array required' }, 400);
  // log: answers per day for the Home stats, { 'YYYY-MM-DD': { ok, no } }; keep the latest 400 days
  let log = {};
  if (body.log && typeof body.log === 'object' && !Array.isArray(body.log)) {
    for (const k of Object.keys(body.log).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort().slice(-400)) {
      const v = body.log[k] || {};
      log[k] = { ok: Math.max(0, Number(v.ok) || 0), no: Math.max(0, Number(v.no) || 0) };
    }
  }
  // history: finished tests for the Test tab, newest first; keep the latest 60
  const history = Array.isArray(body.history) ? body.history.slice(0, 60).filter(h => h && typeof h === 'object') : [];
  // stories: the user's own English stories with study words; keep up to 300
  const stories = Array.isArray(body.stories) ? body.stories.slice(0, 300).filter(x => x && typeof x === 'object') : [];
  // Another device saved after the copy this client started from: send the stored copy back so the client
  // can merge instead of overwriting. (KV is eventually consistent, so this is best effort.)
  const key = `wm:words:${user.sub}`;
  const cur = await env.WORDS.get(key, 'json').catch(() => null);
  if (cur && cur.updatedAt && typeof body.base === 'string' && cur.updatedAt > body.base)
    return json({ conflict: true, data: cur }, 409);
  let now = new Date().toISOString();
  if (cur && cur.updatedAt && now <= cur.updatedAt) now = new Date(Date.parse(cur.updatedAt) + 1).toISOString();
  const record = { cards: body.cards, seed: Number(body.seed) || 0, log, history, stories, updatedAt: now };
  await env.WORDS.put(key, JSON.stringify(record));
  return json({ ok: true, updatedAt: record.updatedAt });
}

// ── Journal ──────────────────────────────────────
// wm:journal:<sub> → { entries: [{ id, at, html, updated, deleted? }], updatedAt }
// PUT merges with the stored copy entry by entry (the later `updated` wins; deletions are kept as
// tombstones for 60 days) so two devices never overwrite each other's entries.
async function getJournal(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'Not signed in' }, 401);
  const data = await env.WORDS.get(`wm:journal:${user.sub}`, 'json').catch(() => null);
  return json(data || { entries: [], updatedAt: null });
}
async function putJournal(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'Not signed in' }, 401);
  const text = await request.text();
  if (text.length > MAX_BODY) return json({ error: 'Journal too large' }, 413);
  let body;
  try { body = JSON.parse(text); } catch { return json({ error: 'Invalid JSON' }, 400); }
  if (!body || !Array.isArray(body.entries)) return json({ error: 'entries array required' }, 400);
  const key = `wm:journal:${user.sub}`;
  const cur = await env.WORDS.get(key, 'json').catch(() => null);
  const byId = new Map();
  const clean = e => e && typeof e === 'object' && typeof e.id === 'string' && e.id.length <= 40
    ? { id: e.id, at: String(e.at || ''), html: e.deleted ? '' : String(e.html || '').slice(0, 200000), updated: Number(e.updated) || 0, ...(e.deleted ? { deleted: true } : {}) } : null;
  for (const e of [...((cur && cur.entries) || []), ...body.entries]) {
    const c = clean(e); if (!c) continue;
    const old = byId.get(c.id);
    if (!old || c.updated >= old.updated) byId.set(c.id, c);
  }
  const cutoff = Date.now() - 60 * 86400000;
  const entries = [...byId.values()].filter(e => !e.deleted || e.updated > cutoff);
  const record = { entries, updatedAt: new Date().toISOString() };
  await env.WORDS.put(key, JSON.stringify(record));
  return json(record);
}


// ── Video (YouTube repeat listening) ───────────
const VIDEO_TTL = 60 * 60 * 24 * 365;
const oldVideo = (env, key) => env.VIDEO_CACHE ? env.VIDEO_CACHE.get(key, 'json').catch(() => null) : null;
async function video(request, env, url) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'Not signed in' }, 401);
  const kind = url.pathname.slice('/api/video/'.length), method = request.method;
  const readBody = async () => {
    const text = await request.text();
    if (text.length > MAX_BODY) throw new Error('too large');
    return JSON.parse(text);
  };
  if (kind === 'history') {
    const key = `wm:vhist:${user.sub}`;
    if (method === 'GET') {
      let h = await env.WORDS.get(key, 'json').catch(() => null);
      if (!h && user.email) h = await oldVideo(env, `hist:${user.email}`);
      return json({ history: Array.isArray(h) ? h : [] });
    }
    if (method === 'PUT') {
      let body; try { body = await readBody(); } catch { return json({ error: 'Invalid JSON' }, 400); }
      if (!Array.isArray(body && body.history)) return json({ error: 'history array required' }, 400);
      const h = body.history.filter(x => x && /^[A-Za-z0-9_-]{11}$/.test(x.videoId)).slice(0, 100)
        .map(x => ({ videoId: x.videoId, title: String(x.title || '').slice(0, 300), date: String(x.date || '').slice(0, 40), s: Math.max(0, parseInt(x.s) || 0) }));
      await env.WORDS.put(key, JSON.stringify(h));
      return json({ ok: true });
    }
    return json({ error: 'Method not allowed' }, 405);
  }
  const vid = url.searchParams.get('v') || '';
  if (!/^[A-Za-z0-9_-]{11}$/.test(vid)) return json({ error: 'v required' }, 400);
  if (kind === 'transcript') {
    const key = `wm:vt:${vid}`;
    if (method === 'GET') {
      const t = await env.WORDS.get(key, 'json').catch(() => null);
      if (t && t.deleted) return json({ error: 'not cached' }, 404);
      const d = t || await oldVideo(env, vid);
      if (!d) return json({ error: 'not cached' }, 404);
      const sentences = Array.isArray(d) ? d : d.sentences;
      if (!Array.isArray(sentences) || !sentences.length) return json({ error: 'not cached' }, 404);
      return json({ sentences, source: (!Array.isArray(d) && d.source) || 'paste' });
    }
    if (method === 'PUT') {
      let body; try { body = await readBody(); } catch { return json({ error: 'Invalid JSON' }, 400); }
      const ss = body && body.sentences;
      if (!Array.isArray(ss) || !ss.length) return json({ error: 'sentences required' }, 400);
      const sentences = ss.slice(0, 5000).map(x => ({ text: String(x.text || ''), start: +x.start || 0, end: +x.end || 0 }));
      await env.WORDS.put(key, JSON.stringify({ sentences, source: String(body.source || 'paste').slice(0, 20) }), { expirationTtl: VIDEO_TTL });
      return json({ ok: true });
    }
    if (method === 'DELETE') {
      // a marker, so the copy from the old app doesn't come back
      await env.WORDS.put(key, JSON.stringify({ deleted: true }), { expirationTtl: VIDEO_TTL });
      await env.WORDS.delete(`wm:vtr:${vid}`).catch(() => {});
      return json({ ok: true });
    }
  }
  if (kind === 'translations') {
    const key = `wm:vtr:${vid}`;
    if (method === 'GET') {
      const t = await env.WORDS.get(`wm:vt:${vid}`, 'json').catch(() => null);
      let tr = await env.WORDS.get(key, 'json').catch(() => null);
      if (!tr && !t) tr = await oldVideo(env, `tr:${vid}`);   // old translations only go with the old transcript
      return json({ translations: tr && typeof tr === 'object' ? tr : {} });
    }
    if (method === 'PUT') {
      let body; try { body = await readBody(); } catch { return json({ error: 'Invalid JSON' }, 400); }
      if (!body || typeof body.translations !== 'object') return json({ error: 'translations required' }, 400);
      await env.WORDS.put(key, JSON.stringify(body.translations), { expirationTtl: VIDEO_TTL });
      return json({ ok: true });
    }
  }
  return json({ error: 'Not found' }, 404);
}

// ── Settings ─────────────────────────────────────
// [field, max length] — the user's own API keys and AI choice
const SETTING_FIELDS = [['translateKey', 200], ['aiProvider', 20], ['openaiKey', 400], ['openaiModel', 80],
  ['geminiKey', 200], ['geminiModel', 80], ['claudeKey', 400], ['claudeModel', 80],
  ['slashLevel', 8], ['slashTr', 4], ['slashRate', 6], ['slashPause', 6],
  ['videoRewind', 4], ['videoForward', 4], ['videoSlow', 4]];
async function getSettings(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'Not signed in' }, 401);
  await linkEmail(env, user).catch(() => {});   // links users who signed in with Google before email sign-in existed
  const s = await env.WORDS.get(`wm:settings:${user.sub}`, 'json').catch(() => null);
  const out = {};
  for (const [k] of SETTING_FIELDS) out[k] = (s && s[k]) || '';
  return json(out);
}

async function putSettings(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'Not signed in' }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const out = {};
  for (const [k, max] of SETTING_FIELDS) {
    const v = String((body && body[k]) || '').trim();
    if (v.length > max || /\s/.test(v)) return json({ error: 'Invalid ' + k }, 400);
    out[k] = v;
  }
  await env.WORDS.put(`wm:settings:${user.sub}`, JSON.stringify(out));
  return json({ ok: true });
}

// ── Dictionary lookup ────────────────────────────
const DICT_TTL = 60 * 60 * 24 * 90;
const MISS_TTL = 60 * 60 * 24;
const UA = 'WordStory/1.0 (https://word-memory.songaal.workers.dev)';

async function lookup(url, env) {
  const word = (url.searchParams.get('word') || '').trim().toLowerCase();
  if (!/^[a-z][a-z' -]{0,48}$/.test(word)) return json({ error: 'invalid' }, 400);
  const key = `wm:dict3:${word}`;
  const fresh = url.searchParams.get('fresh') === '1';
  const debug = url.searchParams.get('debug') === '1';

  if (!fresh) {
    const cached = await env.WORDS.get(key, 'json').catch(() => null);
    if (cached) return cached.notfound ? json({ error: 'notfound' }, 404) : json(cached);
  }

  // Learner's for the definition; Thesaurus for similar words. Asked together.
  const [learners, thes] = await Promise.all([
    safe(() => fromMerriamWebster(word, 'learners', env.MW_LEARNER_KEY)),
    safe(() => fromThesaurus(word, env.MW_THESAURUS_KEY)),
  ]);
  const status = r => r.skipped ? 'skipped (no key)' : r.error ? 'failed: ' + (r.why || 'unknown') : null;
  const sources = {
    learners: status(learners) || (learners.entry ? `found (${countExamples(learners.entry)} examples)` : 'not found'),
    thesaurus: status(thes) || `${thes.list.length} similar words`,
  };

  if (!learners.entry) {
    if (learners.error || learners.skipped) return json({ error: 'unavailable', sources }, 503);
    await env.WORDS.put(key, JSON.stringify({ notfound: true }), { expirationTtl: MISS_TTL });
    return json(debug ? { error: 'notfound', sources } : { error: 'notfound' }, 404);
  }

  const base = learners.entry;
  const synonyms = [];
  for (const sy of thes.list || []) {
    const t = String(sy).toLowerCase();
    if (t !== word && t !== base.word && !synonyms.includes(t)) synonyms.push(t);
  }
  const entry = {
    word: base.word || word,
    phonetic: base.phonetic || '',
    audio: base.audio || '',
    meanings: base.meanings,
    synonyms: synonyms.slice(0, 3),    // the 3 most common (fromThesaurus ranks them); empty if MW has none
    source: 'learners',
  };
  // Cache only once the Thesaurus has answered, so similar words get filled in later otherwise.
  if (!thes.error && !thes.skipped) await env.WORDS.put(key, JSON.stringify(entry), { expirationTtl: DICT_TTL });
  return json(debug ? { ...entry, sources } : entry);
}

// Runs one source; a crash inside it counts as that source failing, not the whole lookup.
async function safe(fn) {
  try { return await fn(); } catch (e) { return { error: true, why: 'crash: ' + (e && e.message || e) }; }
}

async function getJSON(u, timeoutMs = 6000, tries = 2) {
  let why = '';
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(u, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 404) return { status: 404 };
      if (res.ok) {
        const text = await res.text();
        try { return { status: 200, data: JSON.parse(text) }; }
        catch { why = 'not JSON: ' + text.slice(0, 80).replace(/\s+/g, ' '); }
      } else why = 'HTTP ' + res.status;
    } catch (e) { why = (e && e.name === 'TimeoutError') ? 'timeout' : 'network: ' + (e && e.message || e); }
  }
  return { status: 0, why };
}

function countExamples(entry) {
  return entry ? entry.meanings.reduce((n, g) => n + g.defs.filter(d => d.ex).length, 0) : 0;
}

// Merriam-Webster (Learner's or Collegiate). Keys come from Worker secrets, never the repo.
function mwClean(s) {
  return String(s || '')
    .replace(/^\s*\{bc\}/, '').replace(/\s*\{bc\}/g, '; ')
    .replace(/\{dx\}.*?\{\/dx\}/g, '').replace(/\{dx_def\}.*?\{\/dx_def\}/g, '').replace(/\{gloss\}.*?\{\/gloss\}/g, '')
    .replace(/\{(?:a_link|d_link|i_link|et_link|sx|mat|dxt)\|([^|}]*)[^}]*\}/g, '$1')
    .replace(/\{ldquo\}|\{rdquo\}/g, '"')
    .replace(/\{[^}]*\}/g, '')
    .replace(/\s*\[=[^\]]*\]/g, '').replace(/\[\s*\]/g, '').replace(/\s+([,.;:!?])/g, '$1').replace(/\s+/g, ' ').trim();
}
function mwAudioURL(a) {
  if (!a) return '';
  const sub = a.startsWith('bix') ? 'bix' : a.startsWith('gg') ? 'gg' : /^[^a-z]/i.test(a) ? 'number' : a[0].toLowerCase();
  return `https://media.merriam-webster.com/audio/prons/en/us/mp3/${sub}/${a}.mp3`;
}
// Walks a sense's "dt" (defining text) for the definition and example sentences.
function mwSense(sense) {
  let def = '';
  const exs = [];
  const walk = dt => {
    for (const [kind, val] of dt || []) {
      if (kind === 'text' && !def) def = mwClean(val);
      else if (kind === 'vis') for (const v of val || []) exs.push(mwClean(v.t));
      else if (kind === 'uns') for (const u of val || []) walk(u);
      else if (kind === 'snote') for (const [k2, v2] of val || []) if (k2 === 'vis') for (const v of v2 || []) exs.push(mwClean(v.t));
    }
  };
  walk(sense && sense.dt);
  return { def, exs };
}
async function fromMerriamWebster(word, ref, apiKey) {
  if (!apiKey) return { skipped: true };
  const r = await getJSON(`https://www.dictionaryapi.com/api/v3/references/${ref}/json/${encodeURIComponent(word)}?key=${encodeURIComponent(apiKey)}`);
  if (r.status !== 200 || !Array.isArray(r.data)) return { error: true, why: r.why || (r.status === 404 ? 'HTTP 404' : 'unexpected response') };
  const entries = r.data.filter(e => e && typeof e === 'object' && e.meta && e.fl);
  if (!entries.length) return { entry: null }; // MW returns spelling suggestions (strings) when not found
  const base = e => String(e.meta.id || '').split(':')[0].toLowerCase();
  let use = entries.filter(e => base(e) === word);
  if (!use.length) use = entries.filter(e => (e.meta.stems || []).map(x => String(x).toLowerCase()).includes(word));
  if (!use.length) return { entry: null };
  const re = stemRe(base(use[0]));
  let phonetic = '', audio = '';
  const meanings = [];
  for (const e of use) {
    for (const pr of (e.hwi && e.hwi.prs) || []) {
      if (!phonetic && (pr.ipa || pr.mw)) phonetic = '/' + (pr.ipa || pr.mw) + '/';
      if (!audio && pr.sound && pr.sound.audio) audio = mwAudioURL(pr.sound.audio);
    }
    let g = meanings.find(x => x.pos === e.fl);
    if (!g) { g = { pos: e.fl, defs: [] }; meanings.push(g); }
    for (const block of e.def || []) {
      for (const seq of block.sseq || []) {
        const senses = [];
        for (const [type, obj] of seq) {
          if (type === 'sense') senses.push(obj);
          else if (type === 'bs' && obj && obj.sense) senses.push(obj.sense);
          else if (type === 'pseq') for (const [t2, o2] of obj || []) { if (t2 === 'sense') senses.push(o2); else if (t2 === 'bs' && o2 && o2.sense) senses.push(o2.sense); }
        }
        for (const sn of senses) {
          if (g.defs.length >= 3) break;
          const { def, exs } = mwSense(sn);
          if (!def) continue;
          g.defs.push({ d: def, ex: exs.find(x => re.test(x) && x.length <= 220) || '' });
        }
      }
    }
    if (!g.defs.length && Array.isArray(e.shortdef)) e.shortdef.slice(0, 3).forEach(d => g.defs.push({ d: mwClean(d), ex: '' }));
  }
  const kept = meanings.filter(g => g.defs.length).slice(0, 3);
  if (!kept.length) return { entry: null };
  return { entry: { word: base(use[0]), phonetic, audio, meanings: kept, synonyms: [] } };
}

function stemRe(word) {
  const stem = word.length > 4 ? word.slice(0, Math.max(4, word.length - 2)) : word;
  return new RegExp('\\b' + stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

// Merriam-Webster Thesaurus: similar words, most relevant sense first.
let FREQ = null;   // word → rank (0 = most common), built on first use
function freqRank(w) {
  if (!FREQ) { FREQ = new Map(); FREQ_WORDS.split(' ').forEach((x, i) => FREQ.set(x, i)); }
  // multi-word or unknown words count as rare; a phrase ranks by its rarest word
  const parts = w.split(/[\s-]+/);
  let r = 0;
  for (const p of parts) r = Math.max(r, FREQ.has(p) ? FREQ.get(p) : 1e6);
  return r + (parts.length - 1) * 1000;
}
async function fromThesaurus(word, apiKey) {
  if (!apiKey) return { skipped: true, list: [] };
  const r = await getJSON(`https://www.dictionaryapi.com/api/v3/references/thesaurus/json/${encodeURIComponent(word)}?key=${encodeURIComponent(apiKey)}`);
  if (r.status !== 200 || !Array.isArray(r.data)) return { error: true, why: r.why || 'unexpected response', list: [] };
  const entries = r.data.filter(e => e && typeof e === 'object' && e.meta);
  const base = e => String(e.meta.id || '').split(':')[0].toLowerCase();
  let use = entries.filter(e => base(e) === word);
  if (!use.length) use = entries.filter(e => (e.meta.stems || []).map(x => String(x).toLowerCase()).includes(word));
  // Candidates: the main sense's closest words (up to 8; MW lists the closest first), topped up from the
  // other senses only when the main sense has fewer than 3. Then keep the 3 most common (by FREQ_WORDS rank,
  // ties keep MW's order) so learners get familiar words.
  const groups = use.flatMap(e => Array.isArray(e.meta.syns) ? e.meta.syns : []);
  const cand = [];
  const add = w => { w = String(w || '').toLowerCase().trim(); if (w && w !== word && !cand.includes(w)) cand.push(w); };
  (groups[0] || []).slice(0, 8).forEach(add);
  for (let i = 0; i < 4 && cand.length < 3; i++) for (const g of groups.slice(1)) if (cand.length < 3) add(g[i]);
  const list = cand.map((w, i) => ({ w, i, r: freqRank(w) })).sort((a, b) => a.r - b.r || a.i - b.i).slice(0, 3).map(x => x.w);
  return { list };
}
