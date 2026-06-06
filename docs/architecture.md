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

## Memory-Driven Companion Agent

The MVP now treats memory as structured data instead of a plain string list.

Memory types:

- `profile_memory`: stable facts such as name, work, identity, location, and recurring life context.
- `preference_memory`: how the user likes Samantha to answer or what they prefer.
- `episodic_memory`: specific events such as places visited, demos, meetings, or recent experiences.
- `emotional_memory`: recurring emotional states, worries, and support preferences.
- `open_loop_memory`: unfinished topics Samantha should be able to continue later.
- `boundary_memory`: topics, styles, or behaviors the user asked Samantha to avoid.

Each memory row carries metadata such as `importance_score`, `confidence_score`, `last_used_at`, `source_message_id`, `is_user_editable`, `expires_at`, `created_at`, and `updated_at`.

Before each reply, the backend builds `memory_context` from a small selected subset:

- stable profile
- preferences
- relevant long-term memories
- open loops
- emotional patterns
- user boundaries

The model is instructed to use this context sparingly. Memory should make the conversation feel continuous, not like a database dump.

## Response Planning

Before provider routing, the backend builds a private `response_plan`:

- detected emotion
- emotion intensity
- user intent
- conversation mode
- relevant memories
- response strategy
- whether to ask a follow-up
- whether to listen first or give advice
- tone
- safety boundary notes
- what to avoid

This is not shown to the user. It is prompt guidance that keeps Samantha from answering factual questions with comfort templates, overusing memory, or turning every message into a feature menu.

## Memory Management

Users can inspect and manage memory at:

```text
/memories.html
```

APIs:

- `GET /api/user/memories`
- `POST /api/user/memories`
- `GET /api/user/memories/export`

Supported actions are `create`, `update`, `delete`, `incorrect`, `do_not_mention`, and `clear`.

## Voice-Ready Interfaces

The chat payload includes:

- `input_channel`
- `output_channel`
- `voice_session.stt_service`
- `voice_session.tts_service`
- `voice_session.voice_session_service`

The MVP still uses text by default, but the database and prompt layer are ready for speech-to-text and text-to-speech without another schema break.

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
