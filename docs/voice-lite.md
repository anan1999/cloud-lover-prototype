# Samantha Voice-lite MVP

Voice-lite adds optional browser-native voice interaction without any new provider account.

## What It Uses

- Speech-to-text: `SpeechRecognition` or `webkitSpeechRecognition` when the browser supports it.
- Text-to-speech: `window.speechSynthesis`.
- Settings: `localStorage` for `enable_voice_reply`, `voice_rate`, `voice_pitch`, and `preferred_voice_lang`.
- Backend: the existing chat API, provider routing, memory, session, safety, and dashboard paths.

No OpenAI, ElevenLabs, Azure, Google TTS, or other external voice provider is added in this phase.

## How To Use

1. Open the normal chat UI.
2. Click `Mic` near the composer to start listening.
3. Click `Stop` or finish speaking to send the final transcript.
4. Turn on `Samantha voice reply` if you want Samantha's text response to be read aloud.
5. Use `停止語音` to cancel speech.

If browser speech recognition is unavailable, Samantha shows a friendly note and text chat still works.

## Payload Metadata

Voice messages send:

```json
{
  "input_channel": "voice",
  "output_channel": "voice",
  "voice_mode": true
}
```

Text messages send:

```json
{
  "input_channel": "text",
  "output_channel": "text",
  "voice_mode": false
}
```

The `voice_session` object also reports browser support and speech cancel count for lightweight telemetry.

## Backend Behavior

When `voice_mode` is true, `response_plan` asks Samantha to:

- use 1 to 3 short spoken sentences
- avoid markdown-heavy formatting
- avoid code blocks and long lists
- keep warmth and boundaries
- keep long technical explanations only when the user asks for them

Text mode keeps the existing behavior.

## Privacy Notes

- Raw audio is not stored.
- The app only sends the final transcript as a normal user message.
- Microphone permission is controlled by the browser.
- Voice reply is never autoplayed unless the user enables it.

## Current Limitations

- No real-time streaming voice yet.
- Browser speech recognition support varies by browser and OS.
- Some browsers may require HTTPS for microphone access.
- Browser TTS voice quality depends on installed system voices.

## Future Plan

When the MVP is stable, a fuller voice stack can add:

- `MediaRecorder` capture with explicit consent
- backend STT provider
- backend TTS provider
- streaming partial transcripts
- interruption/barge-in behavior
- admin-side quality analytics for voice sessions
