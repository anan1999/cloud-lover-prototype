(function initSamanthaVoiceUtils(root) {
  function getSpeechRecognitionCtor(win = root) {
    return win.SpeechRecognition || win.webkitSpeechRecognition || null;
  }

  function getVoiceSupport(win = root) {
    return {
      speech_recognition_supported: Boolean(getSpeechRecognitionCtor(win)),
      speech_synthesis_supported: Boolean(win.speechSynthesis && win.SpeechSynthesisUtterance)
    };
  }

  function cleanSpeechText(value) {
    return String(value || "")
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/~~~[\s\S]*?~~~/g, " ")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/!\[[^\]]*]\([^)]+\)/g, " ")
      .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/^\s*[-*+]\s+/gm, "")
      .replace(/^\s*\d+[.)]\s+/gm, "")
      .replace(/[>*_~|]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function chooseVoice(voices, preferredLang = "zh-TW") {
    const list = Array.isArray(voices) ? voices : [];
    if (!list.length) return null;
    const lang = String(preferredLang || "zh-TW").toLowerCase();
    const candidates = [
      voice => String(voice.lang || "").toLowerCase() === lang,
      voice => String(voice.lang || "").toLowerCase().startsWith(lang.split("-")[0] + "-"),
      voice => /zh|cmn|yue/i.test(`${voice.lang || ""} ${voice.name || ""}`),
      voice => /en/i.test(`${voice.lang || ""} ${voice.name || ""}`)
    ];
    for (const matcher of candidates) {
      const voice = list.find(matcher);
      if (voice) return voice;
    }
    return list[0] || null;
  }

  const api = {
    cleanSpeechText,
    chooseVoice,
    getSpeechRecognitionCtor,
    getVoiceSupport
  };

  root.SamanthaVoiceUtils = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
