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
//   wm:dict2:<word>    → cached dictionary entry (90 days; "not found" for 1 day)
//
// Dictionary sources, in priority order (the first one with an example sentence wins):
//   1. Merriam-Webster Learner's  (secret MW_LEARNER_KEY)  — asked first
//   2. Merriam-Webster Collegiate (secret MW_COLLEGIATE_KEY)
//   3. Free Dictionary API (dictionaryapi.dev)
//   4. Wiktionary REST API
//   2-4 are asked together, only when Learner's has no example sentence.
//   Similar words: dictionary synonyms here; the app adds Datamuse words from the browser.

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
  const key = `wm:dict2:${word}`;
  const fresh = url.searchParams.get('fresh') === '1';

  if (!fresh) {
    const cached = await env.WORDS.get(key, 'json').catch(() => null);
    if (cached) return cached.notfound ? json({ error: 'notfound' }, 404) : json(cached);
  }

  const debug = url.searchParams.get('debug') === '1';
  // 1) Merriam-Webster Learner's: easy definitions and plenty of example sentences.
  const results = { learners: await safe(() => fromMerriamWebster(word, 'learners', env.MW_LEARNER_KEY)) };
  // 2) If that has no example sentence, ask everyone else at once.
  if (!countExamples(results.learners.entry)) {
    const [col, fd, wk] = await Promise.all([
      safe(() => fromMerriamWebster(word, 'collegiate', env.MW_COLLEGIATE_KEY)),
      safe(() => fromFreeDictionary(word)), safe(() => fromWiktionary(word)),
    ]);
    Object.assign(results, { collegiate: col, freedictionary: fd, wiktionary: wk });
  }
  const order = ['learners', 'collegiate', 'freedictionary', 'wiktionary'];
  const found = order.filter(k => results[k] && results[k].entry);
  const answered = order.filter(k => results[k] && !results[k].error && !results[k].skipped);
  // What each source did, for troubleshooting (shown with ?debug=1 and on "unavailable").
  const sources = {};
  for (const k of order) {
    const r = results[k];
    sources[k] = !r ? 'not asked' : r.skipped ? 'skipped (no key)' : r.error ? 'failed: ' + (r.why || 'unknown') : r.entry ? `found (${countExamples(r.entry)} examples)` : 'not found';
  }

  if (!found.length) {
    if (!answered.length) return json({ error: 'unavailable', sources }, 503);
    const allAnswered = order.every(k => !results[k] || results[k].skipped || !results[k].error);
    if (allAnswered) await env.WORDS.put(key, JSON.stringify({ notfound: true }), { expirationTtl: MISS_TTL });
    return json(debug ? { error: 'notfound', sources } : { error: 'notfound' }, 404);
  }

  // First source in priority order that has an example sentence; otherwise the first one found.
  const pick = found.find(k => countExamples(results[k].entry)) || found[0];
  const base = results[pick].entry;
  const soundFrom = found.map(k => results[k].entry).find(e => e.audio) || base;
  const phonFrom = found.map(k => results[k].entry).find(e => e.phonetic) || base;
  // Similar words: whatever the dictionaries gave, else Free Dictionary's synonym lists.
  // (The app adds Datamuse words from the browser; Datamuse blocks requests from Cloudflare.)
  let synList = found.flatMap(k => results[k].entry.synonyms || []);
  let synTrouble = false;
  if (!synList.length) {
    const fd = results.freedictionary || await safe(() => fromFreeDictionary(word, 4000, 1));
    synTrouble = !!fd.error;
    synList = (fd.entry && fd.entry.synonyms) || [];
    sources.similar = fd.error ? 'freedictionary failed: ' + (fd.why || 'unknown') : `freedictionary (${synList.length})`;
  }
  const synonyms = [];
  for (const sy of synList) {
    const t = String(sy).toLowerCase();
    if (t !== word && !synonyms.includes(t)) synonyms.push(t);
  }
  const entry = {
    word: base.word || word,
    phonetic: phonFrom.phonetic || '',
    audio: soundFrom.audio || '',
    meanings: base.meanings,
    synonyms: synonyms.slice(0, 10),
    source: pick,
  };
  // Don't lock in a backup-only answer while the main dictionaries are having trouble.
  const mainTrouble = ['learners', 'freedictionary'].some(k => results[k] && results[k].error) || (!synonyms.length && synTrouble);
  if (!mainTrouble || pick === 'learners') await env.WORDS.put(key, JSON.stringify(entry), { expirationTtl: DICT_TTL });
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

// Free Dictionary API
async function fromFreeDictionary(word, timeoutMs = 6000, tries = 2) {
  const r = await getJSON('https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(word), timeoutMs, tries);
  if (r.status === 404) return { entry: null };
  if (r.status !== 200 || !Array.isArray(r.data)) return { error: true, why: r.why || (r.status === 404 ? 'HTTP 404' : 'unexpected response') };
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
    .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, '')   // Wiktionary embeds TemplateStyles CSS
    .replace(/<span[^>]*class="[^"]*defdate[^"]*"[^>]*>[\s\S]*?<\/span>/gi, '')   // "from 17th c." date notes
    .replace(/<[^>]*>/g, '')
    .replace(/\.mw-parser-output[^{}]*\{[^}]*\}/g, '')
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
  if (r.status !== 200 || !r.data) return { error: true, why: r.why || 'unexpected response' };
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
