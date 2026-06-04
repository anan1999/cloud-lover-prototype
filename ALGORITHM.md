# Samantha Algorithm Notes

## Current Conversation Pipeline

1. Validate user input and safety-sensitive payload shape.
2. Detect the user's likely emotion: happy, anxious, lonely, stressed, sad, angry, tired, affectionate, confused, or neutral.
3. If logged in, load server-side profile, long-term memories, relationship continuity, and recent messages from Postgres.
4. Merge client memories with database memories using normalized de-duplication.
5. Hydrate the LLM prompt with:
   - current user input
   - Samantha companion profile
   - conversation mode
   - detected emotion state
   - database long-term memory
   - recent database conversation
   - current news headlines when relevant
6. Route across providers in order:

```text
Gemini -> OpenRouter -> NVIDIA -> Groq -> Mock
```

7. Normalize model output into the product contract.
8. Store user message, AI reply, safety label, emotion, provider, memory patches, and relationship continuity.

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
- Safety classifier: replace keyword-only detection with a lightweight classifier plus rule-based hard stops.
- Evaluation dashboard: compare retention, response diversity, safety events, and provider latency by model.
