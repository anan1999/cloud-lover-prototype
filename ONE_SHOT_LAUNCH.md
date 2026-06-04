# One-Shot Launch Plan

This is the fastest path to a real public URL your friends can use on mobile.

## Click This First

```text
https://render.com/deploy?repo=https://github.com/anan1999/cloud-lover-prototype
```

Render will read `render.yaml`, create the web service, and ask you to fill the API keys plus `DATABASE_URL`. After deploy, it gives you a public `https://...onrender.com` URL that friends can open from phones.

Use Neon Free Postgres for `DATABASE_URL` so accounts and chat history do not disappear after a short trial window.

## 1. Rotate Keys First

Keys were pasted during development. Before production, create fresh keys for:

- Gemini
- OpenRouter
- NVIDIA

Use the new keys only in Render environment variables.

## 2. Deploy on Render

If the direct link above is not open anymore, click:

```text
https://render.com/deploy?repo=https://github.com/anan1999/cloud-lover-prototype
```

Then continue with the environment variables below.

1. Go to Render Dashboard.
2. Create a new Web Service.
3. Connect GitHub repo:

```text
anan1999/cloud-lover-prototype
```

4. Runtime: Node
5. Start command:

```text
npm start
```

6. Add environment variables:

```text
NODE_ENV=production
PROVIDER_ORDER=gemini,openrouter,nvidia,groq,mock
EXPOSE_DEBUG=0
ENABLE_PROVIDER_STATUS=0
DATABASE_URL=your_neon_postgres_connection_string
ADMIN_EMAILS=your_admin_login_email

GEMINI_API_KEY=your_new_key
GEMINI_MODEL=gemini-2.5-flash

OPENROUTER_API_KEY=your_new_key
OPENROUTER_MODELS=qwen/qwen3-next-80b-a3b-instruct:free,google/gemma-4-26b-a4b-it:free,google/gemma-4-31b-it:free,moonshotai/kimi-k2.6:free,nvidia/nemotron-3-nano-30b-a3b:free,liquid/lfm-2.5-1.2b-instruct:free

NVIDIA_API_KEY=your_new_key
NVIDIA_MODEL=google/gemma-3n-e2b-it

PROVIDER_TIMEOUT_MS=12000
CACHE_TTL_MS=120000
PROVIDER_COOLDOWN_MS=60000
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=30
BODY_LIMIT_BYTES=65536
```

`ALLOWED_ORIGINS` is optional for the first Render deploy because same-origin requests are allowed automatically. Add it later when you connect a custom domain.

## Other Launch Options

Render is the best first choice for this project because it can run the current Node server without conversion and supports Blueprint secrets.

Railway is the closest alternative. It is also GitHub-based and lets you add environment variables in the dashboard. Use it if Render is slow or the free quota is not enough.

Fly.io is strong for serious production because you can choose regions and run the same Node server, but it is more CLI-heavy.

A VPS is the most professional long-term route after the prototype works. Use Nginx, HTTPS, PM2 or systemd, logs, firewall rules, and a deploy script.

Vercel and Cloudflare Pages are great for frontends, but this app would need a serverless or Workers conversion before they become the cleanest choice.

## 3. Test Render URL

Render will give a URL like:

```text
https://cloud-lover-prototype.onrender.com
```

Open that URL on your phone and send a message.

## 4. Add Custom Domain Later

Recommended:

```text
app.yourdomain.com
```

DNS:

```text
Type: CNAME
Name: app
Value: your-render-service.onrender.com
```

Then set:

```text
ALLOWED_ORIGINS=https://app.yourdomain.com
```

## 5. Pre-Invite Checklist

- [ ] New provider keys created
- [ ] Render deploy succeeds
- [ ] Phone can open the Render URL
- [ ] Normal chat works
- [ ] Dependency-risk message works
- [ ] `/api/provider/status` returns 404 in production
- [ ] Provider budget limits are set
