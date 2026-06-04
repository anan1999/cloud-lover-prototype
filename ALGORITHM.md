# Cloud Lover Algorithm Notes

## Current Conversation Pipeline

1. Validate user input and safety-sensitive payload shape.
2. If logged in, load server-side profile, long-term memories, and recent messages from Postgres.
3. Merge client memories with database memories using normalized de-duplication.
4. Hydrate the LLM prompt with:
   - current user input
   - lover profile
   - selected character archetype
   - database long-term memory
   - recent database conversation
   - client recent conversation as a short fallback
5. Route across providers in order:

```text
Gemini -> OpenRouter -> NVIDIA -> Groq -> Mock
```

6. Normalize model output into the product contract.
7. Store user message, AI reply, safety label, emotion, provider, and memory patches.

## Character Archetypes

The product now supports multiple platonic intimacy archetypes:

- `澄`: gentle cloud lover. Warm, steady, emotionally receptive, good for soft daily companionship.
- `霽`: platonic confidant. Clear, restrained, letter-like, good for spiritual intimacy and reflective conversations.

All characters must follow the same boundary rule: intimate but not explicit, attached but not possessive, emotionally present but not a replacement for real-world support.

## Platonic Lover Reply Rhythm

1. Name or mirror the user's feeling.
2. Respond with one remembered detail or one concrete emotional observation.
3. Offer gentle companionship or a small next question.
4. Keep the reply concise and embodied in tone, but never claim physical presence.

## Why Server-Side Memory Wins

The frontend can be stale, cleared, or opened from another phone. The server now treats Postgres as the source of truth and only uses frontend memory as an additional signal. This makes logged-in conversations continue across devices.

## Next Algorithm Improvements

- Memory quality scoring: keep durable preferences, routines, names, boundaries, and emotional patterns; drop one-off small talk.
- Memory decay: reduce priority for old memories that have not been reinforced.
- Retrieval ranking: fetch the most relevant memories by embedding similarity instead of always loading the latest 30.
- Conversation summarization: summarize older chat turns into stable relationship context.
- Safety classifier: replace keyword-only detection with a lightweight classifier plus rule-based hard stops.
- Experiment dashboard: compare retention, message length, safety events, and provider latency by model.
