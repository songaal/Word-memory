// Cloudflare Worker entry point for Spaced Word Box.
// Static files in public/ are served first; anything else reaches this worker.
//
// POST   /api/auth/login   { idToken }  → verifies a Google ID token, returns { session, user }
// POST   /api/auth/logout               → ends the session
// GET    /api/me                        → current user
// GET    /api/words                     → { cards, seed, updatedAt } for the signed-in user
// PUT    /api/words        { cards, seed, log } → replaces the user's word list and answer log
// GET    /api/lookup?word=              → dictionary entry (no sign-in needed)
// GET    /api/settings                  → { translateKey } for the signed-in user
// PUT    /api/settings     { translateKey } → saves the user's settings
//
// Auth: /api/me and /api/words send "Authorization: Bearer <session>".
// Storage (KV binding WORDS):
//   wm:sess:<session>  → { sub, email, name, picture }   (expires after 60 days)
//   wm:words:<sub>     → { cards, seed, log, updatedAt }
//   wm:settings:<sub>  → { translateKey }   (the user's own Google Translate API key)
//   wm:dict2:<word>    → cached dictionary entry (90 days; "not found" for 1 day)
//
// Dictionary: Merriam-Webster only (keys are Worker secrets, never in the repo).
//   Learner's  (MW_LEARNER_KEY)   — definitions, example sentences, pronunciation
//   Thesaurus  (MW_THESAURUS_KEY) — similar words
//   The app tops up similar words from Datamuse (asked in the browser) when there are fewer than 4.

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
  return json(data || { cards: null, seed: 0, log: {}, updatedAt: null });
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
  const record = { cards: body.cards, seed: Number(body.seed) || 0, log, updatedAt: new Date().toISOString() };
  await env.WORDS.put(`wm:words:${user.sub}`, JSON.stringify(record));
  return json({ ok: true, updatedAt: record.updatedAt });
}

// ── Settings ─────────────────────────────────────
async function getSettings(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'Not signed in' }, 401);
  const s = await env.WORDS.get(`wm:settings:${user.sub}`, 'json').catch(() => null);
  return json({ translateKey: (s && s.translateKey) || '' });
}

async function putSettings(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'Not signed in' }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const translateKey = String((body && body.translateKey) || '').trim();
  if (translateKey.length > 200 || /\s/.test(translateKey)) return json({ error: 'Invalid key' }, 400);
  await env.WORDS.put(`wm:settings:${user.sub}`, JSON.stringify({ translateKey }));
  return json({ ok: true });
}

// ── Dictionary lookup ────────────────────────────
const DICT_TTL = 60 * 60 * 24 * 90;
const MISS_TTL = 60 * 60 * 24;
const UA = 'SpacedWordBox/1.0 (https://word-memory.songaal.workers.dev)';

async function lookup(url, env) {
  const word = (url.searchParams.get('word') || '').trim().toLowerCase();
  if (!/^[a-z][a-z' -]{0,48}$/.test(word)) return json({ error: 'invalid' }, 400);
  const key = `wm:dict2:${word}`;
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
    synonyms: synonyms.slice(0, 10),   // the app tops this up from Datamuse when it's short
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
async function fromThesaurus(word, apiKey) {
  if (!apiKey) return { skipped: true, list: [] };
  const r = await getJSON(`https://www.dictionaryapi.com/api/v3/references/thesaurus/json/${encodeURIComponent(word)}?key=${encodeURIComponent(apiKey)}`);
  if (r.status !== 200 || !Array.isArray(r.data)) return { error: true, why: r.why || 'unexpected response', list: [] };
  const entries = r.data.filter(e => e && typeof e === 'object' && e.meta);
  const base = e => String(e.meta.id || '').split(':')[0].toLowerCase();
  let use = entries.filter(e => base(e) === word);
  if (!use.length) use = entries.filter(e => (e.meta.stems || []).map(x => String(x).toLowerCase()).includes(word));
  // Main sense first (up to 6 words), then the other senses in turn.
  const groups = use.flatMap(e => Array.isArray(e.meta.syns) ? e.meta.syns : []);
  const list = [];
  const add = w => { if (w && !list.includes(w)) list.push(w); };
  (groups[0] || []).slice(0, 6).forEach(add);
  for (let i = 0; i < 10 && list.length < 12; i++) for (const g of groups.slice(1)) add(g[i]);
  (groups[0] || []).slice(6).forEach(w => list.length < 12 && add(w));
  return { list };
}
