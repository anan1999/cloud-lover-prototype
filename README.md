# Cloud Lover Prototype

An AI companion prototype with multi-provider fallback and production-oriented safety controls.

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

Deploy this folder as a Node app on Render, Railway, Fly.io, a VPS, or another Node hosting platform.

See [DEPLOYMENT.md](./DEPLOYMENT.md) for the full Render launch checklist.

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
- Set `NODE_ENV=production` on the host.
- Set `ALLOWED_ORIGINS` to your real domain.
- Keep `EXPOSE_DEBUG=0` and `ENABLE_PROVIDER_STATUS=0` in production.
- Disable Codex provider in production.
- Set spend caps and rate limits in provider dashboards.
- Review `privacy.html`, `terms.html`, and `safety.html` before inviting users.

## Git

`.env.local` and logs are ignored by `.gitignore`.
