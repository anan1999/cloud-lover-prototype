# Samantha AI Companion MVP

An emotionally aware AI companion MVP inspired by a warm personal operating-system assistant. Samantha supports natural chat, long-term memory, emotion-aware responses, conversation modes, multi-provider fallback, user accounts, a database-backed chat history, and production-oriented safety controls.

Samantha is not a fake human, therapist, girlfriend, boyfriend, or emergency service. The product is designed to feel warm and continuous while keeping healthy boundaries.

Recommended production routing:

```text
Gemini -> Codex
```

Mock is disabled for production quality. If Gemini and Codex both fail or time out, Samantha uses a non-mock grounded fallback for safe, memory-aware, or factual scaffolding instead of pretending that an LLM succeeded.

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

## Quality Tests

Run these against a local server before pushing conversation or provider changes:

```powershell
$env:SMOKE_URL="http://127.0.0.1:8787"
npm run smoke:quality

$env:REGRESSION_URL="http://127.0.0.1:8787"
npm run regression:quality
```

`smoke:quality` checks the shortest no-mock path and defaults to `codex_only` so the replies must come from a real LLM route. `regression:quality` covers the issues that previously appeared: fact questions turning into comfort templates, wrong event recall, AIEXPO/COMPUTEX confusion, unsafe dependency replies, mock fallback, and stale third-party providers.

To force larger test suites through Codex instead of grounded rules:

```powershell
$env:REGRESSION_PROVIDER_MODE="codex_only"
$env:REGRESSION_REQUIRE_REAL_PROVIDER="1"
npm run regression:quality
```

For broader coverage, sample the 10,000-question bank:

```powershell
$env:BANK_SAMPLE_URL="http://127.0.0.1:8787"
$env:BANK_SAMPLE_LIMIT="100"
$env:BANK_SAMPLE_CASE_TIMEOUT_MS="8000"
$env:BANK_SAMPLE_PROVIDER_MODE="codex_only"
$env:BANK_SAMPLE_REQUIRE_REAL_PROVIDER="1"
npm run eval:sample
```

`BANK_SAMPLE_CASE_TIMEOUT_MS` keeps the evaluator honest: a slow or stuck round becomes a visible failed case instead of hanging the whole test run.

## Product Architecture

- Frontend: `index.html` chat UI, account UI, companion settings, conversation mode selector, memory panel, and developer diagnostics.
- Backend: `server.js` static server, auth, chat API, memory manager, emotion detector, prompt builder, provider router, token usage tracking, and admin APIs.
- Data: Neon Postgres in production, local JSON fallback in development.
- Docs: see [docs/architecture.md](./docs/architecture.md), [docs/prompt_design.md](./docs/prompt_design.md), and [docs/safety_guidelines.md](./docs/safety_guidelines.md).

Reply routing is intentionally layered, so not every answer is pure Google LLM output. Open-ended chat goes through Gemini first and Codex second. Safety, memory recall, fact repair, and known regression cases first build a grounded draft from retrieval/rules; when a provider is available, Gemini or Codex naturalizes that draft into a warmer Samantha voice. If providers are unavailable, Samantha can still use local style variation on the grounded draft. This keeps mock disabled while avoiding stale canned replies.

Admin dashboard:

- Open `/admin.html` with an email listed in `ADMIN_EMAILS`.
- Token panels call `/api/admin/token-usage` and show estimated context/reply tokens, inferred API tokens, provider totals, model totals, and the last 14 days of token usage.
- When Gemini/OpenAI/Codex-compatible providers return usage metadata, Samantha stores the provider token counts. If a route has no provider usage, the dashboard falls back to estimation.
- Grounded/rules replies record estimated text tokens but show `0` API tokens because they do not call a paid external model.
- Evaluation runs can use `grounded`, `codex_only`, or `gemini_codex` route modes. Use `grounded` for large stable tests, `codex_only` when Gemini is rate-limited, and `gemini_codex` for slow production-route tests.
- Evaluation metrics now include Samantha-specific quality dimensions: continuity, specificity, warmth, boundary, memory precision, non-generic response quality, rhythm, and helpfulness.

Memory management:

- Open `/memories.html` after logging in.
- Users can view, edit, delete, mark incorrect, mark "do not mention", clear, and export Samantha memories.
- Memory is stored as structured rows: profile, preference, episodic, emotional, open-loop, and boundary memory.
- Each memory has importance, confidence, last-used time, source message id, editability, optional expiry, and metadata.

Private response planning:

- Each reply builds a private `response_plan` before provider routing.
- The plan tracks emotion, intent, conversation action, tone intelligence, dialogue contract, mode, selected memories, strategy, follow-up choice, whether to listen first or advise, and safety notes.
- The model is told not to reveal these labels. They are scaffolding for more natural continuity.
- A post-generation dialogue and tone self-check blocks common failures such as fact questions becoming comfort templates, memory questions echoing the question, corrections not being repaired, customer-service phrasing, report tone, markdown leakage in voice mode, and overlong spoken replies.

Voice-lite MVP:

- The chat UI now includes optional browser-native speech input and Samantha voice reply.
- Speech input uses `SpeechRecognition` / `webkitSpeechRecognition` when available; unsupported browsers fall back to text chat.
- Voice reply uses `window.speechSynthesis`, strips markdown/code blocks before speaking, and can be cancelled.
- Voice settings live in `localStorage`: `enable_voice_reply`, `voice_rate`, `voice_pitch`, `preferred_voice_lang`, and `preferred_voice_name`.
- The UI ranks browser voices, lets the user choose a voice, previews it, uses gentler default rate/pitch, and plays replies sentence by sentence so browser TTS sounds less robotic.
- Chat payloads include `input_channel`, `output_channel`, `voice_mode`, and `voice_session` metadata.
- Raw audio is not stored; only the final transcript is sent as a normal user message.
- Admin dashboard includes Voice Lab, a transcript-based voice test bot that scores spoken reply length, markdown/list leakage, and playback quality with browser TTS.
- More details: [docs/voice-lite.md](docs/voice-lite.md).

Task model routing design:

- Emotion and memory extraction: local fast rules first, optional fast model later.
- Main reply: Gemini first, Codex fallback.
- Repair and factual safety: grounded rules first, Codex if needed.
- Judge/evaluation: local heuristics now, Codex can be added for deeper review later.

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
PROVIDER_ORDER=gemini,codex
ENABLE_CODEX_PROVIDER=1
ENABLE_MOCK_FALLBACK=0
ENABLE_EXPERIMENTAL_PROVIDERS=0
ALLOWED_ORIGINS=https://your-domain.example
EXPOSE_DEBUG=0
ENABLE_PROVIDER_STATUS=0
DATABASE_URL=postgresql://...
ADMIN_EMAILS=you@example.com

GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.5-flash
GEMINI_MODELS=gemini-2.5-flash,gemini-2.0-flash,gemini-2.0-flash-lite,gemini-flash-lite-latest

CODEX_BACKEND=api
CODEX_API_KEY=...
CODEX_MODEL=gpt-5.5
CODEX_COMMAND=
CODEX_TIMEOUT_MS=60000
CODEX_NATURALIZE_TIMEOUT_MS=60000
CODEX_CLI_PROMPT_MODE=stdin
CODEX_WORKER_URL=
CODEX_WORKER_TOKEN=

PROVIDER_TIMEOUT_MS=60000
GEMINI_TIMEOUT_MS=12000
GROUNDED_NATURALIZE_TIMEOUT_MS=1500
GEMINI_NATURALIZE_TIMEOUT_MS=1500
MOCK_FALLBACK_DELAY_MS=60000
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
- Use `Gemini -> Codex` in production. Gemini gets a short fast-path timeout; Codex can wait up to one minute. Keep mock disabled for quality testing and real users.
- Keep `ENABLE_EXPERIMENTAL_PROVIDERS=0` unless you intentionally test old third-party providers. This prevents stale OpenRouter/NVIDIA keys from entering the route.
- Use `CODEX_BACKEND=api` or a warm `CODEX_WORKER_URL` for fast production fallback. `CODEX_BACKEND=cli` is useful locally, but every request starts a Codex process and is much slower. On Windows, the server auto-detects the real Codex binary under `%LOCALAPPDATA%\OpenAI\Codex\bin`; set `CODEX_COMMAND` only if you need to override it.
- Keep `CODEX_CLI_PROMPT_MODE=stdin` for CLI fallback. This sends the full Samantha prompt through stdin instead of command-line arguments, so long memory/context prompts are not truncated.
- `GEMINI_NATURALIZE_TIMEOUT_MS` can stay short for quick quota/error detection; `CODEX_NATURALIZE_TIMEOUT_MS` should be longer when you prefer stable Codex fallback over immediate grounded wording.
- Set spend caps and rate limits in provider dashboards.
- Review `privacy.html`, `terms.html`, and `safety.html` before inviting users.

## Git

`.env.local` and logs are ignored by `.gitignore`.
