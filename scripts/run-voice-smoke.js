const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const indexHtml = fs.readFileSync(path.join(root, "index.html"), "utf8");
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
  assertIncludes(indexHtml, "voice_mode: voiceMode", "index.html");
  assertIncludes(indexHtml, "input_channel: inputChannel", "index.html");
  assertIncludes(indexHtml, "output_channel: outputChannel", "index.html");
  assertIncludes(indexHtml, "speech_recognition_supported", "index.html");
  assertIncludes(indexHtml, "speech_synthesis_supported", "index.html");
  assertIncludes(indexHtml, "speech_cancel_count", "index.html");
  assertIncludes(indexHtml, "localStorage", "index.html");
  assertIncludes(indexHtml, "speechSynthesis.cancel()", "index.html");
  assertIncludes(indexHtml, "renderVoiceStatus(\"這個瀏覽器暫不支援內建語音輸入；你可以繼續打字。\")", "index.html");

  assertIncludes(voiceUtilsSource, "SpeechRecognition", "voice-utils.js");
  assertIncludes(voiceUtilsSource, "webkitSpeechRecognition", "voice-utils.js");
  assertIncludes(voiceUtilsSource, "cleanSpeechText", "voice-utils.js");

  assertIncludes(serverJs, "short_spoken_reply", "server.js");
  assertIncludes(serverJs, "voice_telemetry", "server.js");
  assertIncludes(serverJs, "Voice mode: avoid markdown", "server.js");
  assertIncludes(serverJs, "conversation.voice_mode =", "server.js");
  assertIncludes(serverJs, "1 到 3 句自然口語", "server.js");

  assertNotIncludes(indexHtml, "MediaRecorder", "index.html");
  assertNotIncludes(indexHtml, "raw_audio", "index.html");
  assertNotIncludes(serverJs, "raw_audio", "server.js");
  assertNotIncludes(serverJs, "audio_data", "server.js");

  console.log("voice smoke checks passed");
}

run();
