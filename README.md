# Spaced Word Box

English vocabulary app with automatic dictionary lookup and spaced-repetition tests.

- Type a word → definition, similar words, examples, and pronunciation are filled in from the Free Dictionary API.
- Daily test: an example sentence with a blank, then the definition. Up to 3 hints (first letter → first 3 letters / 30% → 50%).
- Wrong answers return tomorrow; right answers return after 3, 7, 14, 30, then 60 days.
- Sign in with Google to keep your words on every device (or use it without signing in, saved in the browser only).

## Run locally

```bash
npm install
npx wrangler dev
```

## Deploy

Pushing to `main` deploys to Cloudflare Workers through GitHub Actions.

One-time setup:
1. Add the repository secret `CLOUDFLARE_API_TOKEN` (Settings → Secrets and variables → Actions). The same token as video-repeat-player works.
2. In Google Cloud Console → Credentials → the OAuth client used by video-repeat-player, add the deployed URL (e.g. `https://word-memory.<your-subdomain>.workers.dev`) to **Authorized JavaScript origins**.
