# Samantha AI Companion MVP

An emotionally aware AI companion MVP inspired by a warm personal operating-system assistant. Samantha supports natural chat, long-term memory, emotion-aware responses, conversation modes, multi-provider fallback, user accounts, a database-backed chat history, and production-oriented safety controls.

Samantha is not a fake human, therapist, girlfriend, boyfriend, or emergency service. The product is designed to feel warm and continuous while keeping healthy boundaries.

Recommended production routing:

```text
Gemini -> OpenRouter -> NVIDIA -> Groq -> Mock
```

Codex provider is for local development only and is disabled when `NODE_ENV=production`.

## Local Development

```powershell
cd C:\Users\hi\Documents\Codex\2026-06-04\new-chat\outputs
.\start-cloud-lover.ps1
```

Open:

```text
http://localhost:8787
```

## Temporary Public Sharing

Use a tunnel when you only want friends to try it briefly:

```powershell
cloudflared tunnel --url http://localhost:8787
```

or:

```powershell
ngrok http 8787
```

This exposes your local machine temporarily. Stop the tunnel when testing is done.

## Production Deploy

Fastest path:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/anan1999/cloud-lover-prototype)

Direct link:

```text
https://render.com/deploy?repo=https://github.com/anan1999/cloud-lover-prototype
```

Render will ask for provider API keys because `render.yaml` marks them as `sync: false`; the keys stay in Render secrets and are not committed to GitHub.

See [DEPLOYMENT.md](./DEPLOYMENT.md) for the full Render launch checklist.
For the shortest launch path, use [ONE_SHOT_LAUNCH.md](./ONE_SHOT_LAUNCH.md).

## Product Architecture

- Frontend: `index.html` chat UI, account UI, companion settings, conversation mode selector, memory panel, and developer diagnostics.
- Backend: `server.js` static server, auth, chat API, memory manager, emotion detector, prompt builder, provider router, and admin APIs.
- Data: Neon Postgres in production, local JSON fallback in development.
- Docs: see [docs/architecture.md](./docs/architecture.md), [docs/prompt_design.md](./docs/prompt_design.md), and [docs/safety_guidelines.md](./docs/safety_guidelines.md).

Conversation modes:

- `casual_chat`: relaxed daily conversation.
- `emotional_support`: comfort and reflection.
- `work_helper`: technical or work-related help.
- `reflection_mode`: thinking through feelings or decisions.

Other good hosting choices:

- Railway: easiest alternative to Render for this Node server. Connect GitHub, add environment variables, deploy.
- Fly.io: best when you want lower latency in specific regions, but it needs CLI setup.
- VPS: most control and stable long-term, but you manage server security, updates, HTTPS, logs, and backups.
- Vercel or Cloudflare Pages: better after converting this app to serverless functions or Workers.

Start command:

```text
npm start
```

Set environment variables in the hosting platform. Do not upload `.env.local`.

```text
NODE_ENV=production
PROVIDER_ORDER=gemini,openrouter,nvidia,groq,mock
ALLOWED_ORIGINS=https://your-domain.example
EXPOSE_DEBUG=0
ENABLE_PROVIDER_STATUS=0
DATABASE_URL=postgresql://...
ADMIN_EMAILS=you@example.com

GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.5-flash

OPENROUTER_API_KEY=...
OPENROUTER_MODELS=qwen/qwen3-next-80b-a3b-instruct:free,google/gemma-4-26b-a4b-it:free,google/gemma-4-31b-it:free,moonshotai/kimi-k2.6:free,nvidia/nemotron-3-nano-30b-a3b:free,liquid/lfm-2.5-1.2b-instruct:free

NVIDIA_API_KEY=...
NVIDIA_MODEL=google/gemma-3n-e2b-it

PROVIDER_TIMEOUT_MS=12000
CACHE_TTL_MS=120000
PROVIDER_COOLDOWN_MS=60000
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=30
BODY_LIMIT_BYTES=65536
```

## Security Checklist

- Rotate any API key that was pasted into chat, screenshots, browser history, or logs.
- Never commit `.env.local`.
- Use a long-lived external Postgres database such as Neon for user accounts and chat history.
- Set `ADMIN_EMAILS` to the account emails allowed to open `/admin.html`.
- Set `NODE_ENV=production` on the host.
- Set `ALLOWED_ORIGINS` to your real domain.
- Keep `EXPOSE_DEBUG=0` and `ENABLE_PROVIDER_STATUS=0` in production.
- Disable Codex provider in production.
- Set spend caps and rate limits in provider dashboards.
- Review `privacy.html`, `terms.html`, and `safety.html` before inviting users.

## Git

`.env.local` and logs are ignored by `.gitignore`.
