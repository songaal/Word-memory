# Spaced Word Box — Project Rules

## Versioning (MANDATORY — apply on every change)

The app version is shown at the bottom of `public/index.html`:

```html
<span class="version-tag">v1.5.0</span> · <span class="version-date">2026/10/18</span>
```

1. **Always bump the version** — no commit should leave the version unchanged.
2. **Patch (third digit)**: bug fix, style tweak, or small change. e.g. v1.0.0 → v1.0.1
3. **Minor (second digit)**: new user-facing feature (reset patch to 0). e.g. v1.0.x → v1.1.0
4. **Date**: update to today's date in `YYYY/MM/DD` format every time.

**Current version: v1.5.0 — 2026/10/18**

## Architecture

- **Frontend**: `public/index.html` — single-file app, no build step. All UI text is English.
  - Learning is example-first: each word card lists numbered example sentences, each with its definition underneath (no number); similar words come last.
  - Dictionary: looked up through `GET /api/lookup` on the worker (never directly from the browser).
  - Sound: dictionary audio for words; browser speech (Web Speech API) for sentences.
  - Translation: toggle button next to each example sentence → Korean via Google Cloud Translation v2, called from the browser with the user's own API key (Settings tab, ⚙). Translations are saved on the card (`exKo`).
- **Backend**: `src/index.js` — Cloudflare Worker
  - `POST /api/auth/login` — verifies a Google ID token, creates a session (KV, 60 days)
  - `POST /api/auth/logout`, `GET /api/me`
  - `GET/PUT /api/words` — the signed-in user's whole word list (`wm:words:<google sub>`)
  - `GET/PUT /api/settings` — the signed-in user's settings, e.g. Google Translate API key (`wm:settings:<google sub>`). Guests keep settings in localStorage.
  - `GET /api/lookup?word=` — Merriam-Webster Learner's (definition, examples, pronunciation) + Merriam-Webster Thesaurus (similar words), asked together. Cached in KV (`wm:dict2:<word>`, 90 days) once the Thesaurus has answered. `&fresh=1` skips the cache; `&debug=1` adds a `sources` report.
  - The browser tops up similar words from Datamuse when the Thesaurus gives fewer than 4 (Datamuse returns HTTP 403 to Cloudflare Workers).
- **Secrets** (Cloudflare dashboard → Worker → Settings → Variables and Secrets, never in the repo): `MW_LEARNER_KEY`, `MW_THESAURUS_KEY`. Without the Learner's key, lookups return "unavailable"; without the Thesaurus key, similar words come only from Datamuse.
- **Storage**: Workers KV namespace `word-memory`, binding `WORDS`. Keys start with `wm:`.
- **Auth**: Google Identity Services, same OAuth client as video-repeat-player.
- **Deploy**: Cloudflare Workers Builds (GitHub connected in the Cloudflare dashboard) — auto on push to `main`.
  - **Do not push to `main` until the user asks to deploy.** Verify changes locally first (local worker + browser test), commit locally, and push only on request.
- **URL**: https://word-memory.songaal.workers.dev

## Review schedule

- Wrong → tomorrow, stage reset.
- Right → 3, 7, 14, 30, 60 days.
- Right with 2+ hints → tomorrow, stage unchanged.
- Words already tested today are practice and don't change the schedule.
