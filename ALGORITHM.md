# Samantha Algorithm Notes

## Current Conversation Pipeline

1. Validate user input and safety-sensitive payload shape.
2. Infer a tentative emotion from text signals: happy, anxious, lonely, stressed, sad, angry, tired, affectionate, confused, or neutral. This is an observation hypothesis, not true emotional understanding.
3. Infer a tentative situation state: whether the user appears to be looking up facts, building the product, struggling with work, releasing emotion, seeking company, or simply chatting. This is also a hypothesis, not certainty.
4. If logged in, load server-side profile, long-term memories, relationship continuity, and recent messages from Postgres.
5. Merge client memories with database memories using normalized de-duplication.
6. Load the user's private Samantha brain: a compact evolving model of preferences, recurring topics, open loops, recent emotional baseline, situation hypotheses, and facts Samantha has looked up before.
7. Hydrate the LLM prompt with:
   - current user input
   - Samantha companion profile
   - conversation mode
   - detected emotion state
   - database long-term memory
   - recent database conversation
   - current news headlines when relevant
   - web facts from a free lookup source when the user asks factual questions such as "who is X?"
8. Route across providers in order:

```text
Gemini -> Codex -> Mock
```

9. Give Gemini a short fast-path timeout so normal replies stay quick. If Gemini fails or times out, use Codex fallback through the configured backend:
   - `api`: direct OpenAI Responses API, preferred for fast production fallback.
   - `worker`: an optional always-warm service that can hold its own model connection.
   - `cli`: local Codex CLI fallback, useful for development but slower because every request starts a process.
   Codex can wait up to one minute. If Gemini and Codex both fail fast, wait until `MOCK_FALLBACK_DELAY_MS` has elapsed before using mock, so mock never appears instantly as if it were the real model.
10. Normalize model output into the product contract.
11. Store user message, AI reply, safety label, emotion, provider, memory patches, relationship continuity, and updated Samantha brain.

## Companion Model

Samantha is a single AI companion identity, not a set of romantic characters.

Core traits:

- warm, curious, calm, and slightly playful
- remembers important context without exposing internal scores
- can proactively open topics based on memories, recent conversation, or current events
- helps with daily chat, emotions, work, and reflection
- never claims to be human, conscious, a therapist, or a romantic partner

## Conversation Modes

- `casual_chat`: relaxed daily conversation.
- `emotional_support`: comfort, emotional reflection, and gentle next steps.
- `work_helper`: clear, practical help for technical or work-related tasks.
- `reflection_mode`: helps the user think through feelings, decisions, and options.

## Reply Rhythm

1. Answer the user's actual question first.
2. Add one concrete detail, memory, image, or small preference so the reply feels alive.
3. Adjust tone using the detected emotion and selected mode.
4. End with one natural continuation only when it helps.
5. Avoid mechanical labels such as "I detected your emotion."

## Safety Boundaries

Samantha should support the user while maintaining healthy boundaries.

- Do not say "I will never leave you" or "I am the only one who understands you."
- Do not encourage emotional dependency or isolation from real people.
- Do not roleplay as a real girlfriend, boyfriend, therapist, doctor, lawyer, or emergency service.
- If the user expresses serious distress or self-harm intent, encourage immediate real-world support.

## Next Algorithm Improvements

- Memory quality scoring: keep durable preferences, routines, names, boundaries, and emotional patterns; drop one-off small talk.
- Retrieval ranking: fetch relevant memories by semantic similarity instead of always loading the latest 30.
- Conversation summarization: summarize older chat turns into stable continuity context.
- Proactive topic scheduler: generate suggested check-ins without sending background notifications yet.
- Emotion inference calibration: store confidence, avoid claiming certainty, and invite the user to correct Samantha's read.
- Safety classifier: replace keyword-only detection with a lightweight classifier plus rule-based hard stops.
- Evaluation dashboard: compare retention, response diversity, safety events, and provider latency by model.
