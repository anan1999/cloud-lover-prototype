# Production Deployment

This project is ready to deploy as a Node web service.

## Recommended First Launch

Use Render first because it connects cleanly to GitHub and supports environment variables.

Repository:

```text
https://github.com/anan1999/cloud-lover-prototype
```

Start command:

```text
npm start
```

## Step 1: Create Render Service

1. Open Render Dashboard.
2. Create a new Web Service.
3. Connect GitHub repository `anan1999/cloud-lover-prototype`.
4. Use Node runtime.
5. Use `npm start` as the start command.
6. Deploy.

Render will give you a default domain similar to:

```text
https://cloud-lover-prototype.onrender.com
```

## Step 2: Set Environment Variables

Set these in Render Dashboard, not in git:

```text
NODE_ENV=production
PROVIDER_ORDER=gemini,openrouter,nvidia,groq,mock
ALLOWED_ORIGINS=https://cloud-lover-prototype.onrender.com
EXPOSE_DEBUG=0
ENABLE_PROVIDER_STATUS=0
DATABASE_URL=postgresql://...
ADMIN_EMAILS=you@example.com

GEMINI_API_KEY=your_new_gemini_key
GEMINI_MODEL=gemini-2.5-flash

OPENROUTER_API_KEY=your_new_openrouter_key
OPENROUTER_MODELS=qwen/qwen3-next-80b-a3b-instruct:free,google/gemma-4-26b-a4b-it:free,google/gemma-4-31b-it:free,moonshotai/kimi-k2.6:free,nvidia/nemotron-3-nano-30b-a3b:free,liquid/lfm-2.5-1.2b-instruct:free

NVIDIA_API_KEY=your_new_nvidia_key
NVIDIA_MODEL=google/gemma-3n-e2b-it

PROVIDER_TIMEOUT_MS=12000
CACHE_TTL_MS=120000
PROVIDER_COOLDOWN_MS=60000
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=30
BODY_LIMIT_BYTES=65536
```

Important: rotate the Gemini, OpenRouter, and NVIDIA keys that were pasted into chat before using production.

For accounts and chat history, use a long-lived external Postgres database for `DATABASE_URL`. Recommended free-first path is Neon Free Postgres. Supabase Free Postgres is also usable, but idle free projects can pause. Avoid Render Free Postgres for important production data because it is short-lived/trial-oriented.

## Step 3: Verify Launch

Open:

```text
https://cloud-lover-prototype.onrender.com
```

Test:

- Send a normal message.
- Send a dependency-risk message like `我覺得自己最近太依賴你了`.
- Check that developer details are not exposed in normal production mode.

The `/api/provider/status` endpoint should return `404` in production unless `ENABLE_PROVIDER_STATUS=1`.

## Step 4: Custom Domain

After the Render default domain works, add a custom subdomain:

```text
app.yourdomain.com
```

DNS:

```text
Type: CNAME
Name: app
Value: your-render-service.onrender.com
```

Then update Render environment variable:

```text
ALLOWED_ORIGINS=https://app.yourdomain.com
```

## Launch Checklist

- [ ] API keys rotated
- [ ] `NODE_ENV=production`
- [ ] `ALLOWED_ORIGINS` set to the real domain
- [ ] `EXPOSE_DEBUG=0`
- [ ] `ENABLE_PROVIDER_STATUS=0`
- [ ] `DATABASE_URL` points to Neon or another long-lived Postgres database
- [ ] `ADMIN_EMAILS` includes only trusted dashboard users
- [ ] `PROVIDER_ORDER` does not include `codex`
- [ ] Provider dashboards have budget/spend limits
- [ ] App tested with normal and safety-risk messages
- [ ] Custom domain DNS verified
- [ ] Privacy, terms, and safety pages reviewed for your jurisdiction
