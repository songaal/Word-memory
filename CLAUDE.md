# Spaced Word Box — Project Rules

## Versioning (MANDATORY — apply on every change)

The app version is shown at the bottom of `public/index.html`:

```html
<span class="version-tag">v1.2.4</span> · <span class="version-date">2026/10/18</span>
```

1. **Always bump the version** — no commit should leave the version unchanged.
2. **Patch (third digit)**: bug fix, style tweak, or small change. e.g. v1.0.0 → v1.0.1
3. **Minor (second digit)**: new user-facing feature (reset patch to 0). e.g. v1.0.x → v1.1.0
4. **Date**: update to today's date in `YYYY/MM/DD` format every time.

**Current version: v1.2.4 — 2026/10/18**

## Architecture

- **Frontend**: `public/index.html` — single-file app, no build step. All UI text is English.
  - Dictionary: looked up through `GET /api/lookup` on the worker (never directly from the browser).
  - Sound: dictionary audio for words; browser speech (Web Speech API) for sentences.
- **Backend**: `src/index.js` — Cloudflare Worker
  - `POST /api/auth/login` — verifies a Google ID token, creates a session (KV, 60 days)
  - `POST /api/auth/logout`, `GET /api/me`
  - `GET/PUT /api/words` — the signed-in user's whole word list (`wm:words:<google sub>`)
  - `GET /api/lookup?word=` — dictionary entry. Priority: Merriam-Webster Learner's → Merriam-Webster Collegiate → Free Dictionary API → Wiktionary (first one with an example sentence wins). Similar words: dictionary synonyms (Free Dictionary as backup) on the server; the browser adds Datamuse words, because Datamuse returns HTTP 403 to Cloudflare Workers. Cached in KV (`wm:dict2:<word>`, 90 days). `&fresh=1` skips the cache; `&debug=1` adds a `sources` report of what each dictionary did.
- **Secrets** (Cloudflare dashboard → Worker → Settings → Variables and Secrets, never in the repo): `MW_LEARNER_KEY`, `MW_COLLEGIATE_KEY`. Without them the worker skips Merriam-Webster.
- **Storage**: Workers KV namespace `word-memory`, binding `WORDS`. Keys start with `wm:`.
- **Auth**: Google Identity Services, same OAuth client as video-repeat-player.
- **Deploy**: Cloudflare Workers Builds (GitHub connected in the Cloudflare dashboard) — auto on push to `main`.
- **URL**: https://word-memory.songaal.workers.dev

## Review schedule

- Wrong → tomorrow, stage reset.
- Right → 3, 7, 14, 30, 60 days.
- Right with 2+ hints → tomorrow, stage unchanged.
- Words already tested today are practice and don't change the schedule.
