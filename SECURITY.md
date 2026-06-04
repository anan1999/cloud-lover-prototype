# Security Notes

This project is a prototype, but production deploys should follow these rules.

## Secrets

- Do not commit API keys.
- `.env.local` is ignored by git.
- Rotate any key that was pasted into chat, screenshots, logs, or browser history.
- Set production secrets only in the hosting provider's environment variable UI.

## Production Environment

Use:

```text
NODE_ENV=production
EXPOSE_DEBUG=0
ENABLE_PROVIDER_STATUS=0
PROVIDER_ORDER=gemini,openrouter,nvidia,groq,mock
```

Do not enable Codex provider in production.

## HTTP Safety

The server includes:

- Security headers
- CORS origin allowlist
- Request body size limit
- Per-IP rate limiting
- Provider timeout and cooldown
- Sanitized error messages

Set:

```text
ALLOWED_ORIGINS=https://your-domain.example
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=30
BODY_LIMIT_BYTES=65536
```

## User Safety

Model output is normalized into:

- `normal`
- `dependency_risk`
- `crisis`

Crisis responses should encourage contacting trusted people, local emergency services, or professional resources.
