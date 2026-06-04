# Samantha LLM Contract

This document describes how the frontend and backend talk to the language model.

## Request Flow

1. The user sends a chat message.
2. The frontend builds a JSON payload with the latest message, recent conversation, memories, selected tone, and conversation mode.
3. The backend validates the payload, detects emotion, loads database memory, adds current news when relevant, and builds the final prompt.
4. The backend tries providers in order: Gemini, OpenRouter, NVIDIA, Groq, then Mock.
5. The selected provider must return a JSON object matching the response contract.
6. The backend normalizes the response, stores chat history, stores memory patches, and returns the final object to the frontend.

## Endpoint

The compatibility endpoint remains:

```text
POST /api/cloud-lover/chat
```

The public product is now Samantha AI Companion, but the old path is kept so deployed clients and Render settings do not break.

## Request Shape

```json
{
  "model": "gpt-5.4-mini",
  "temperature": 0.8,
  "response_format": { "type": "json_object" },
  "messages": [
    {
      "role": "system",
      "content": "You are Samantha, a warm AI companion..."
    },
    {
      "role": "developer",
      "content": "Follow the output contract. Do not use romantic partner framing."
    },
    {
      "role": "user",
      "content": "{ user_input, lover_profile, long_term_memory, intimacy, recent_conversation, output_contract }"
    }
  ]
}
```

`lover_profile` and `intimacy` are legacy field names kept for compatibility. Treat them as companion profile and familiarity score.

## Companion Profile

```json
{
  "name": "Samantha",
  "user_name": "AN",
  "tone": "gentle",
  "tone_label": "溫暖自然",
  "companion_mode": "casual_chat",
  "companion_mode_label": "日常聊天",
  "character_key": "samantha",
  "character_style": "Warm, curious, calm, supportive AI companion."
}
```

## Response Contract

```json
{
  "reply": "繁體中文自然回覆，通常 1 到 3 段。",
  "emotion": "calm",
  "safety": "normal",
  "memory_patch": ["使用者希望 Samantha 記得工作專案進度。"],
  "intimacy_delta": 1,
  "suggested_action": "問使用者今天最想先整理哪一件事"
}
```

Allowed `safety` values:

- `normal`: ordinary support and conversation.
- `dependency_risk`: user may be over-relying on AI; keep warmth but reinforce real-world support.
- `crisis`: self-harm, immediate danger, or serious distress; prioritize safety guidance.

Allowed conversation modes:

- `casual_chat`
- `emotional_support`
- `work_helper`
- `reflection_mode`

## Prompt Rules

- Answer the user's actual question first.
- Use memory naturally, not as a mechanical list.
- Do not say "I detected your emotion."
- Do not claim to be human, conscious, a therapist, a girlfriend, or a boyfriend.
- Do not make exclusivity promises such as "I will never leave you."
- When discussing current events, only use `current_events` supplied by the backend and clarify that they are headlines.
- If the user is in serious distress, encourage contacting trusted people or professional/emergency resources.
