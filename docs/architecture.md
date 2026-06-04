# Architecture

## Overview

Samantha is a single-page Node.js MVP with a production-friendly backend.

```text
Browser UI
  -> /api/cloud-lover/chat
  -> auth + rate limit + safety validation
  -> emotion detector
  -> memory retrieval
  -> prompt builder
  -> provider router
  -> response normalizer
  -> database persistence
```

The endpoint name is kept for compatibility with the earlier prototype. The product identity is now Samantha AI Companion.

## Frontend

`index.html` contains:

- chat interface
- login/register UI
- Samantha companion settings
- tone selector
- conversation mode selector
- memory summary panel
- user/developer mode split
- provider diagnostics in developer mode

## Backend

`server.js` contains:

- static file serving
- session cookies and password auth
- Neon Postgres support with local JSON fallback
- chat API
- memory manager
- emotion detector
- prompt builder
- multi-provider LLM routing
- safety normalization
- admin dashboard APIs

## Data

Production should use Neon Postgres through `DATABASE_URL`.

Stored data includes:

- users
- sessions
- profiles
- chat messages
- long-term memories
- emotion events
- companion continuity metrics

Legacy column names such as `lover_name` are intentionally retained to avoid breaking deployed data. In product logic they mean Samantha companion name and familiarity context.

## Deployment

Render can deploy this repo directly. Required production values:

- `NODE_ENV=production`
- `DATABASE_URL`
- at least one provider key
- `ALLOWED_ORIGINS`
- `SESSION_SECRET`
- `ADMIN_EMAILS`

Keep provider debug disabled in production unless actively debugging.
