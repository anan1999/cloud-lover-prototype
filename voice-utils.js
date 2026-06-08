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

  function voiceScore(voice, preferredLang = "zh-TW", preferredName = "") {
    const lang = String(preferredLang || "zh-TW").toLowerCase();
    const name = String(voice?.name || "");
    const voiceLang = String(voice?.lang || "").toLowerCase();
    const haystack = `${name} ${voiceLang}`.toLowerCase();
    let score = 0;
    if (preferredName && name === preferredName) score += 1000;
    if (voiceLang === lang) score += 180;
    else if (voiceLang.startsWith(lang.split("-")[0] + "-")) score += 120;
    if (/zh|cmn|yue|mandarin|chinese|中文|國語|普通話/i.test(`${name} ${voiceLang}`)) score += 80;
    if (/natural|online|premium|enhanced|neural|xiaoxiao|hsiaochen|yunxi|yunyang|xiaoyi|hanhan|meijia|mei-jia|ting-ting|sin-ji|曉臻|曉曉|雲希|雲揚|美佳|漢漢/i.test(`${name} ${voiceLang}`)) score += 70;
    if (/taiwan|traditional|zh-tw|臺灣|台灣/i.test(`${name} ${voiceLang}`)) score += 35;
    if (/google|microsoft|apple/i.test(haystack)) score += 12;
    if (/compact|eloquence|espeak|robot|novelty/i.test(haystack)) score -= 80;
    if (/english|en-us|en-gb/i.test(haystack) && !/^en/i.test(lang)) score -= 50;
    return score;
  }

  function sortedVoices(voices, preferredLang = "zh-TW", preferredName = "") {
    const list = Array.isArray(voices) ? voices : [];
    return [...list].sort((a, b) => voiceScore(b, preferredLang, preferredName) - voiceScore(a, preferredLang, preferredName));
  }

  function chooseVoice(voices, preferredLang = "zh-TW", preferredName = "") {
    const list = sortedVoices(voices, preferredLang, preferredName);
    if (!list.length) return null;
    if (preferredName) {
      const exact = list.find(voice => voice.name === preferredName);
      if (exact) return exact;
    }
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

  function splitSpeechText(value, maxLength = 90) {
    const text = cleanSpeechText(value);
    if (!text) return [];
    const parts = text.match(/[^。！？!?；;]+[。！？!?；;]?/gu) || [text];
    const chunks = [];
    for (const part of parts.map(item => item.trim()).filter(Boolean)) {
      if (part.length <= maxLength) {
        chunks.push(part);
        continue;
      }
      for (let index = 0; index < part.length; index += maxLength) {
        chunks.push(part.slice(index, index + maxLength));
      }
    }
    return chunks.slice(0, 8);
  }

  const api = {
    cleanSpeechText,
    chooseVoice,
    sortedVoices,
    splitSpeechText,
    voiceScore,
    getSpeechRecognitionCtor,
    getVoiceSupport
  };

  root.SamanthaVoiceUtils = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
