# Spaced Word Box

English vocabulary app with automatic dictionary lookup and spaced-repetition tests.

- Type a word → definition, similar words, examples, and pronunciation are filled in from Merriam-Webster (similar words from Datamuse).
- Daily test: an example sentence with a blank, then the definition. Up to 3 hints (first letter → first 3 letters / 30% → 50%).
- Wrong answers return tomorrow; right answers return after 3, 7, 14, 30, then 60 days.
- Sign in with Google to keep your words on every device (or use it without signing in, saved in the browser only).

## Run locally

```bash
npm install
npx wrangler dev
```

## Deploy

Live at https://word-memory.songaal.workers.dev

Cloudflare Workers Builds is connected to this repository, so every push to `main` deploys automatically.
Google sign-in requires `https://word-memory.songaal.workers.dev` in the OAuth client's **Authorized JavaScript origins**.
