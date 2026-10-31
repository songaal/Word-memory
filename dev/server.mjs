// Local test server for Word Story (not deployed: only public/ and src/ go to Cloudflare).
//   node dev/server.mjs            → http://localhost:8787
// Runs the real worker (src/index.js) with an in-memory KV instead of Cloudflare KV.
// A signed-in test session is pre-made: put these in the browser's localStorage, then reload:
//   wm.session = 11111111-2222-3333-4444-555555555555
//   wm.user    = {"sub":"u1","email":"s@example.com","name":"Sammy"}
// (or wm.guest = 1 for guest mode). Merriam-Webster is mocked for "galore" and "dubious";
// other words come back "not found". Data is lost when the server stops.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const worker = (await import(path.join(root, 'src/index.js'))).default;
const store = new Map();
const KV = {
  get: async (k, t) => { const v = store.get(k); return v == null ? null : (t === 'json' ? JSON.parse(v) : v); },
  put: async (k, v) => { store.set(k, v); },
  delete: async k => { store.delete(k); },
};
store.set('wm:sess:11111111-2222-3333-4444-555555555555', JSON.stringify({ sub: 'u1', email: 's@example.com', name: 'Sammy', picture: '' }));
const MW = {
  galore: [{ meta: { id: 'galore', stems: ['galore'] }, hwi: { prs: [{ ipa: 'gəˈloɚ' }] }, fl: 'adjective', def: [{ sseq: [[['sense', { dt: [['text', '{bc}in large numbers or amounts'], ['vis', [{ t: 'The store promises bargains {it}galore{/it} during its weekend sale.' }]]] }]]] }] }],
  dubious: [{ meta: { id: 'dubious', stems: ['dubious'] }, hwi: { prs: [{ ipa: 'ˈduːbijəs' }] }, fl: 'adjective', def: [{ sseq: [[['sense', { dt: [['text', '{bc}unsure or uncertain'], ['vis', [{ t: 'I was {it}dubious{/it} about our chances for success.' }]]] }]]] }] }],
};
const TH = { galore: [{ meta: { id: 'galore', syns: [['abundant', 'plentiful', 'copious']] }, fl: 'adjective' }], dubious: [{ meta: { id: 'dubious', syns: [['doubtful', 'skeptical', 'uncertain']] }, fl: 'adjective' }] };
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => {
  const us = String(u);
  const word = () => decodeURIComponent(us.split('/json/')[1].split('?')[0]);
  if (us.includes('/references/learners/')) return new Response(JSON.stringify(MW[word()] || ['suggestion']));
  if (us.includes('/references/thesaurus/')) return new Response(JSON.stringify(TH[word()] || []));
  return realFetch(u, o);
};
const TYPES = { '.html': 'text/html', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.js': 'text/javascript', '.css': 'text/css' };
const ASSETS = { fetch: async req => {
  const p = new URL(req.url).pathname, f = path.join(root, 'public', p === '/' ? 'index.html' : p);
  if (fs.existsSync(f) && fs.statSync(f).isFile()) return new Response(fs.readFileSync(f), { headers: { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' } });
  return new Response('Not found', { status: 404 });
} };
http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const r = new Request('http://localhost:8787' + req.url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) });
  const out = await worker.fetch(r, { WORDS: KV, ASSETS, MW_LEARNER_KEY: 'dev', MW_THESAURUS_KEY: 'dev' });
  res.writeHead(out.status, Object.fromEntries(out.headers)); res.end(Buffer.from(await out.arrayBuffer()));
}).listen(8787, () => console.log('Word Story dev server: http://localhost:8787'));
