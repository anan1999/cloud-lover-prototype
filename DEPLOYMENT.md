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
PROVIDER_ORDER=gemini,codex
ENABLE_CODEX_PROVIDER=1
ENABLE_MOCK_FALLBACK=0
ALLOWED_ORIGINS=https://cloud-lover-prototype.onrender.com
EXPOSE_DEBUG=0
ENABLE_PROVIDER_STATUS=0
DATABASE_URL=postgresql://...
ADMIN_EMAILS=you@example.com

GEMINI_API_KEY=your_new_gemini_key
GEMINI_MODEL=gemini-2.5-flash

CODEX_BACKEND=api
CODEX_API_KEY=your_openai_api_key
CODEX_MODEL=gpt-5.5
CODEX_TIMEOUT_MS=3333
CODEX_WORKER_URL=
CODEX_WORKER_TOKEN=

PROVIDER_TIMEOUT_MS=60000
CACHE_TTL_MS=120000
PROVIDER_COOLDOWN_MS=60000
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=30
BODY_LIMIT_BYTES=65536
```

Important: rotate any provider keys that were pasted into chat before using production.

Production fallback should use `CODEX_BACKEND=api` or `CODEX_BACKEND=worker`. Render cannot use the Codex login from your local desktop app, so `CODEX_BACKEND=api` needs `CODEX_API_KEY` or `OPENAI_API_KEY`.

`CODEX_TIMEOUT_MS=3333` is the "5 seconds accelerated by 1.5x" cap. It keeps the chat responsive, but it does not make `codex exec` cold start faster. If you set `CODEX_BACKEND=cli`, every request starts a Codex process; that is useful locally but not ideal for formal launch.

Optional local CLI fallback:

```text
CODEX_BACKEND=cli
CODEX_COMMAND=C:\Users\hi\AppData\Local\OpenAI\Codex\bin\716dda49c14d31a0\codex.exe
```

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
- [ ] `PROVIDER_ORDER=gemini,codex`
- [ ] `ENABLE_CODEX_PROVIDER=1`
- [ ] `ENABLE_MOCK_FALLBACK=0`
- [ ] Provider dashboards have budget/spend limits
- [ ] App tested with normal and safety-risk messages
- [ ] Custom domain DNS verified
- [ ] Privacy, terms, and safety pages reviewed for your jurisdiction
