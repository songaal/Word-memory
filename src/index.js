// Cloudflare Worker entry point for Spaced Word Box.
// Static files in public/ are served first; anything else reaches this worker.
//
// POST   /api/auth/login   { idToken }  → verifies a Google ID token, returns { session, user }
// POST   /api/auth/logout               → ends the session
// GET    /api/me                        → current user
// GET    /api/words                     → { cards, seed, updatedAt } for the signed-in user
// PUT    /api/words        { cards, seed } → replaces the user's word list
// GET    /api/lookup?word=              → dictionary entry (no sign-in needed)
//
// Auth: /api/me and /api/words send "Authorization: Bearer <session>".
// Storage (KV binding WORDS):
//   wm:sess:<session>  → { sub, email, name, picture }   (expires after 60 days)
//   wm:words:<sub>     → { cards, seed, updatedAt }
//   wm:dict:<word>     → cached dictionary entry (90 days; "not found" for 1 day)
//
// Dictionary sources, asked in parallel:
//   Free Dictionary API (dictionaryapi.dev) — definitions, examples, phonetic, audio
//   Wiktionary REST API — definitions and examples; backup when Free Dictionary fails, and
//                         preferred when it has more example sentences
//   Datamuse — similar words (synonyms, then "means like")

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
      if (pathname === '/api/me' && method === 'GET') return await me(request, env);
      if (pathname === '/api/words' && method === 'GET') return await getWords(request, env);
      if (pathname === '/api/words' && method === 'PUT') return await putWords(request, env);
      if (pathname === '/api/lookup' && method === 'GET') return await lookup(url, env);
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

// ── Dictionary lookup ────────────────────────────
const DICT_TTL = 60 * 60 * 24 * 90;
const MISS_TTL = 60 * 60 * 24;
const UA = 'SpacedWordBox/1.0 (https://word-memory.songaal.workers.dev)';

async function lookup(url, env) {
  const word = (url.searchParams.get('word') || '').trim().toLowerCase();
  if (!/^[a-z][a-z' -]{0,48}$/.test(word)) return json({ error: 'invalid' }, 400);
  const key = `wm:dict:${word}`;
  const fresh = url.searchParams.get('fresh') === '1';

  if (!fresh) {
    const cached = await env.WORDS.get(key, 'json').catch(() => null);
    if (cached) return cached.notfound ? json({ error: 'notfound' }, 404) : json(cached);
  }

  const [fd, wk, syn] = await Promise.all([
    fromFreeDictionary(word), fromWiktionary(word), fromDatamuse(word),
  ]);

  // Both dictionaries down (not just "word missing"): tell the app to try again later.
  if (fd.error && wk.error) return json({ error: 'unavailable' }, 503);

  const entry = combine(word, fd.entry, wk.entry, syn);
  if (!entry) {
    if (!fd.error && !wk.error) await env.WORDS.put(key, JSON.stringify({ notfound: true }), { expirationTtl: MISS_TTL });
    return json({ error: 'notfound' }, 404);
  }
  // Only cache when Free Dictionary answered, so a temporary outage doesn't lock in a result without audio.
  if (!fd.error) await env.WORDS.put(key, JSON.stringify(entry), { expirationTtl: DICT_TTL });
  return json(entry);
}

async function getJSON(u, timeoutMs = 6000, tries = 2) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(u, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 404) return { status: 404 };
      if (res.ok) return { status: 200, data: await res.json() };
    } catch (e) { /* timeout or network error: retry */ }
  }
  return { status: 0 };
}

function countExamples(entry) {
  return entry ? entry.meanings.reduce((n, g) => n + g.defs.filter(d => d.ex).length, 0) : 0;
}

function combine(word, fd, wk, syn) {
  if (!fd && !wk) return null;
  // Use whichever dictionary has more example sentences; keep Free Dictionary's sound either way.
  const base = countExamples(wk) > countExamples(fd) ? wk : (fd || wk);
  const synonyms = [];
  for (const s of [...(fd ? fd.synonyms : []), ...syn]) {
    const t = s.toLowerCase();
    if (t !== word && !synonyms.includes(t)) synonyms.push(t);
  }
  return {
    word: (fd && fd.word) || word,
    phonetic: (fd && fd.phonetic) || '',
    audio: (fd && fd.audio) || '',
    meanings: base.meanings,
    synonyms: synonyms.slice(0, 10),
    source: base === wk ? 'wiktionary' : 'freedictionary',
  };
}

// Free Dictionary API
async function fromFreeDictionary(word) {
  const r = await getJSON('https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(word));
  if (r.status === 404) return { entry: null };
  if (r.status !== 200 || !Array.isArray(r.data)) return { error: true };
  let phonetic = '', audio = '';
  const syn = new Set(), meanings = [];
  for (const e of r.data) {
    if (!phonetic && e.phonetic) phonetic = e.phonetic;
    for (const p of e.phonetics || []) {
      if (!phonetic && p.text) phonetic = p.text;
      if (!audio && p.audio) audio = p.audio;
    }
    for (const m of e.meanings || []) {
      (m.synonyms || []).forEach(s => syn.add(s));
      let g = meanings.find(x => x.pos === m.partOfSpeech);
      if (!g) { g = { pos: m.partOfSpeech, defs: [] }; meanings.push(g); }
      for (const d of m.definitions || []) {
        (d.synonyms || []).forEach(s => syn.add(s));
        if (g.defs.length < 3) g.defs.push({ d: d.definition, ex: d.example || '' });
      }
    }
  }
  if (!meanings.length) return { entry: null };
  return { entry: { word: r.data[0].word || word, phonetic, audio, meanings: meanings.slice(0, 3), synonyms: [...syn] } };
}

// Wiktionary REST API (English section only)
function stripHTML(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ').trim();
}
function stemRe(word) {
  const stem = word.length > 4 ? word.slice(0, Math.max(4, word.length - 2)) : word;
  return new RegExp('\\b' + stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}
async function fromWiktionary(word) {
  const r = await getJSON('https://en.wiktionary.org/api/rest_v1/page/definition/' + encodeURIComponent(word));
  if (r.status === 404) return { entry: null };
  if (r.status !== 200 || !r.data) return { error: true };
  const re = stemRe(word);
  const meanings = [];
  for (const sec of r.data.en || []) {
    const pos = String(sec.partOfSpeech || '').toLowerCase();
    let g = meanings.find(x => x.pos === pos);
    if (!g) { g = { pos, defs: [] }; meanings.push(g); }
    for (const d of sec.definitions || []) {
      const def = stripHTML(d.definition);
      if (!def || g.defs.length >= 3) continue;
      const exs = [...(d.parsedExamples || []).map(x => x.example), ...(d.examples || [])]
        .map(stripHTML).filter(x => x && x.length <= 220 && re.test(x));
      g.defs.push({ d: def, ex: exs[0] || '' });
    }
  }
  const kept = meanings.filter(g => g.defs.length).slice(0, 3);
  if (!kept.length) return { entry: null };
  return { entry: { word, phonetic: '', audio: '', meanings: kept, synonyms: [] } };
}

// Datamuse similar words
async function fromDatamuse(word) {
  const q = encodeURIComponent(word);
  const [a, b] = await Promise.all([
    getJSON(`https://api.datamuse.com/words?rel_syn=${q}&max=10`, 4000, 1),
    getJSON(`https://api.datamuse.com/words?ml=${q}&max=10`, 4000, 1),
  ]);
  const list = [...(Array.isArray(a.data) ? a.data : []), ...(Array.isArray(b.data) ? b.data : [])]
    .map(x => x.word).filter(w => w && w.split(' ').length <= 2);
  return list;
}
