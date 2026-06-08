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

Local and admin-only test routing can force a real provider path with `provider_mode: "codex_only"` or `provider_mode: "gemini_codex"` plus `require_real_provider: true`. Public production chat ignores that override unless the caller is an admin, so normal users cannot force expensive provider usage. The quality scripts use this path when the goal is to measure real LLM behavior rather than grounded fallback behavior.

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
- conversation action
- tone intelligence plan
- dialogue contract
- conversation mode
- relevant memories
- response strategy
- whether to ask a follow-up
- whether to listen first or give advice
- tone
- safety boundary notes
- what to avoid

This is not shown to the user. It is prompt guidance that keeps Samantha from answering factual questions with comfort templates, overusing memory, or turning every message into a feature menu.

The `tone_intelligence` layer chooses a concrete conversation action before generation, such as `answer_directly`, `soft_acknowledge`, `continue_topic`, `repair_misunderstanding`, `recall_memory`, `ground_with_fact`, `small_practical_step`, `proactive_topic`, or `stop_and_leave_space`. After a provider returns, the backend applies a lightweight tone self-check that removes common customer-service phrasing, report tone, markdown leakage in voice mode, and overlong spoken replies. Evaluation metrics include `action_fit_score` so the dashboard can show whether Samantha picked the right conversational move, not only whether the answer was warm.

The `dialogue_contract` layer is a stronger turn-level agreement. It identifies whether the user move is `answer_fact`, `remember`, `repair`, `continue`, or emotional support; lists what must be answered first; and records keywords or memory details that should appear. After the provider returns, `applyDialogueQualityGate` checks for common failures before the reply is sent: fact questions that became comfort, memory questions that echo the current question, corrections that were not repaired, short acknowledgements that restart the conversation, over-systemized replies, and near duplicates. If a reply fails the gate, Samantha falls back to the safest local repair rather than asking the user to correct the same problem again.

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

## Voice-lite Interfaces

The MVP now implements optional browser-native voice without adding a provider account. The chat payload includes:

- `input_channel`
- `output_channel`
- `voice_mode`
- `voice_session.stt_service`
- `voice_session.tts_service`
- `voice_session.voice_session_service`
- `voice_session.preferred_voice_lang`
- `voice_session.preferred_voice_name`
- `voice_session.voice_style`
- `voice_session.voice_rate`
- `voice_session.voice_pitch`
- `voice_session.speech_recognition_supported`
- `voice_session.speech_synthesis_supported`
- `voice_session.speech_cancel_count`

The frontend uses `SpeechRecognition` / `webkitSpeechRecognition` for speech-to-text when available and `speechSynthesis` for text-to-speech. Text remains the default path. No raw audio is stored; only the final transcript is sent to the existing chat API. When `voice_mode` is true, `response_plan` asks Samantha for shorter, more conversational spoken replies with less markdown.

`response_plan.voice_profile` normalizes the browser voice settings into a backend contract. It stores the selected style (`warm`, `clear`, `low`, or `bright`), browser voice name, rate/pitch hints, playback strategy, raw-audio privacy status, and a future `samantha_original_voice` slot for an original/custom TTS provider.

The admin dashboard also includes `voice_lab`, a transcript-based voice test bot. It runs the normal evaluation pipeline with `voice_mode: true`, stores results in `evaluation_runs` / `evaluation_messages`, and can play the latest transcript aloud in the browser. This gives spoken quality feedback without introducing a real audio upload or STT/TTS provider yet.

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
