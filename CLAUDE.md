# Spaced Word Box — Project Rules

## Versioning (MANDATORY — apply on every change)

The app version is shown at the bottom of `public/index.html`:

```html
<span class="version-tag">v1.0.0</span> · <span class="version-date">2026/10/17</span>
```

1. **Always bump the version** — no commit should leave the version unchanged.
2. **Patch (third digit)**: bug fix, style tweak, or small change. e.g. v1.0.0 → v1.0.1
3. **Minor (second digit)**: new user-facing feature (reset patch to 0). e.g. v1.0.x → v1.1.0
4. **Date**: update to today's date in `YYYY/MM/DD` format every time.

**Current version: v1.0.0 — 2026/10/17**

## Architecture

- **Frontend**: `public/index.html` — single-file app, no build step. All UI text is English.
  - Dictionary: Free Dictionary API (dictionaryapi.dev), called from the browser.
  - Sound: dictionary audio for words; browser speech (Web Speech API) for sentences.
- **Backend**: `src/index.js` — Cloudflare Worker
  - `POST /api/auth/login` — verifies a Google ID token, creates a session (KV, 60 days)
  - `POST /api/auth/logout`, `GET /api/me`
  - `GET/PUT /api/words` — the signed-in user's whole word list (`wm:words:<google sub>`)
- **Storage**: Workers KV, binding `WORDS`. Shares the namespace with video-repeat-player; all keys start with `wm:`.
- **Auth**: Google Identity Services, same OAuth client as video-repeat-player.
- **Deploy**: GitHub Actions → Cloudflare Workers (auto on push to `main`). Needs repo secret `CLOUDFLARE_API_TOKEN`.

## Review schedule

- Wrong → tomorrow, stage reset.
- Right → 3, 7, 14, 30, 60 days.
- Right with 2+ hints → tomorrow, stage unchanged.
- Words already tested today are practice and don't change the schedule.
