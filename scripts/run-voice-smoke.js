const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const indexHtml = fs.readFileSync(path.join(root, "index.html"), "utf8");
const adminHtml = fs.readFileSync(path.join(root, "admin.html"), "utf8");
const serverJs = fs.readFileSync(path.join(root, "server.js"), "utf8");
const voiceUtilsSource = fs.readFileSync(path.join(root, "voice-utils.js"), "utf8");
const voiceUtils = require(path.join(root, "voice-utils.js"));

function assertIncludes(source, needle, label) {
  assert.ok(source.includes(needle), `${label} should include ${needle}`);
}

function assertNotIncludes(source, needle, label) {
  assert.ok(!source.includes(needle), `${label} should not include ${needle}`);
}

function run() {
  assert.deepEqual(voiceUtils.getVoiceSupport({}), {
    speech_recognition_supported: false,
    speech_synthesis_supported: false
  });

  const fakeWindow = {
    webkitSpeechRecognition: function FakeRecognition() {},
    speechSynthesis: {},
    SpeechSynthesisUtterance: function FakeUtterance() {}
  };
  assert.equal(voiceUtils.getSpeechRecognitionCtor(fakeWindow), fakeWindow.webkitSpeechRecognition);
  assert.deepEqual(voiceUtils.getVoiceSupport(fakeWindow), {
    speech_recognition_supported: true,
    speech_synthesis_supported: true
  });

  const selectedVoice = voiceUtils.chooseVoice([
    { name: "English", lang: "en-US" },
    { name: "Taiwan Mandarin", lang: "zh-TW" }
  ], "zh-TW");
  assert.equal(selectedVoice.lang, "zh-TW");
  const preferredVoice = voiceUtils.chooseVoice([
    { name: "Basic Chinese", lang: "zh-TW" },
    { name: "Microsoft HsiaoChen Online Natural", lang: "zh-TW" }
  ], "zh-TW", "Microsoft HsiaoChen Online Natural");
  assert.equal(preferredVoice.name, "Microsoft HsiaoChen Online Natural");
  const voiceChunks = voiceUtils.splitSpeechText("第一句。第二句很長但還是應該分開播放，聽起來比較不像機器一口氣把整段全部唸完。", 20);
  assert.ok(voiceChunks.length >= 2);

  const speechText = voiceUtils.cleanSpeechText([
    "# Title",
    "Here is **warm** text with [a link](https://example.com).",
    "```js",
    "console.log('do not speak this');",
    "```",
    "- one"
  ].join("\n"));
  assert.equal(speechText.includes("console.log"), false);
  assert.equal(speechText.includes("```"), false);
  assert.equal(speechText.includes("**"), false);
  assert.equal(speechText.includes("[a link]"), false);
  assert.ok(speechText.includes("warm"));

  assertIncludes(indexHtml, "id=\"micBtn\"", "index.html");
  assertIncludes(indexHtml, "id=\"voiceReplyToggle\"", "index.html");
  assertIncludes(indexHtml, "id=\"voiceNameSelect\"", "index.html");
  assertIncludes(indexHtml, "id=\"voiceStyleSelect\"", "index.html");
  assertIncludes(indexHtml, "id=\"voicePreviewBtn\"", "index.html");
  assertIncludes(indexHtml, "voice_mode: voiceMode", "index.html");
  assertIncludes(indexHtml, "input_channel: inputChannel", "index.html");
  assertIncludes(indexHtml, "output_channel: outputChannel", "index.html");
  assertIncludes(indexHtml, "speech_recognition_supported", "index.html");
  assertIncludes(indexHtml, "speech_synthesis_supported", "index.html");
  assertIncludes(indexHtml, "speech_cancel_count", "index.html");
  assertIncludes(indexHtml, "preferred_voice_name", "index.html");
  assertIncludes(indexHtml, "voice_style", "index.html");
  assertIncludes(indexHtml, "voiceStylePresets", "index.html");
  assertIncludes(indexHtml, "applyVoiceStyle", "index.html");
  assertIncludes(indexHtml, "currentVoiceStylePreset", "index.html");
  assertIncludes(indexHtml, "populateVoiceOptions", "index.html");
  assertIncludes(indexHtml, "splitSpeechText", "index.html");
  assertIncludes(indexHtml, "localStorage", "index.html");
  assertIncludes(indexHtml, "speechSynthesis.cancel()", "index.html");
  assertIncludes(indexHtml, "renderVoiceStatus(\"這個瀏覽器暫不支援內建語音輸入；你可以繼續打字。\")", "index.html");

  assertIncludes(voiceUtilsSource, "SpeechRecognition", "voice-utils.js");
  assertIncludes(voiceUtilsSource, "webkitSpeechRecognition", "voice-utils.js");
  assertIncludes(voiceUtilsSource, "cleanSpeechText", "voice-utils.js");
  assertIncludes(voiceUtilsSource, "voiceScore", "voice-utils.js");
  assertIncludes(voiceUtilsSource, "sortedVoices", "voice-utils.js");
  assertIncludes(voiceUtilsSource, "splitSpeechText", "voice-utils.js");

  assertIncludes(serverJs, "short_spoken_reply", "server.js");
  assertIncludes(serverJs, "voice_telemetry", "server.js");
  assertIncludes(serverJs, "voice_profile", "server.js");
  assertIncludes(serverJs, "buildVoiceProfile", "server.js");
  assertIncludes(serverJs, "future_custom_voice_slot", "server.js");
  assertIncludes(serverJs, "consent_required_for_voice_clone", "server.js");
  assertIncludes(serverJs, "dialogue_contract", "server.js");
  assertIncludes(serverJs, "applyDialogueQualityGate", "server.js");
  assertIncludes(serverJs, "EVALUATION_SCENARIOS.voice_lab", "server.js");
  assertIncludes(serverJs, "voice_reply_too_long", "server.js");
  assertIncludes(serverJs, "voice_template_tone", "server.js");
  assertIncludes(serverJs, "tone_intelligence", "server.js");
  assertIncludes(serverJs, "conversation_action", "server.js");
  assertIncludes(serverJs, "applyToneSelfCheck", "server.js");
  assertIncludes(serverJs, "action_fit_score", "server.js");
  assertIncludes(serverJs, "allowMockFallback: false", "server.js");
  assertIncludes(serverJs, "requireRealProvider", "server.js");
  assertIncludes(serverJs, "skipCache: requireRealProvider", "server.js");
  assertIncludes(serverJs, "voice_mode: Boolean(voiceMode)", "server.js");
  assertIncludes(serverJs, "Voice mode: avoid markdown", "server.js");
  assertIncludes(serverJs, "conversation.voice_mode =", "server.js");
  assertIncludes(serverJs, "像傳一則短語音訊息", "server.js");

  assertIncludes(adminHtml, "id=\"runVoiceLabBtn\"", "admin.html");
  assertIncludes(adminHtml, "id=\"playVoiceLabBtn\"", "admin.html");
  assertIncludes(adminHtml, "playLatestVoiceLab", "admin.html");
  assertIncludes(adminHtml, "speechSynthesis", "admin.html");
  assertIncludes(adminHtml, "voice_mode: voiceMode", "admin.html");
  assertIncludes(adminHtml, "mock 已禁用", "admin.html");
  assertIncludes(adminHtml, "value=\"codex_only\"", "admin.html");
  assertIncludes(adminHtml, "Action fit", "admin.html");

  assertNotIncludes(indexHtml, "MediaRecorder", "index.html");
  assertNotIncludes(indexHtml, "raw_audio", "index.html");
  assertNotIncludes(serverJs, "raw_audio", "server.js");
  assertNotIncludes(serverJs, "audio_data", "server.js");

  console.log("voice smoke checks passed");
}

run();
