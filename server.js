const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

loadLocalEnv();

const PORT = Number(process.env.PORT || 8787);
const ROOT = __dirname;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.4-mini";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.1-8b-instant";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "qwen/qwen3-next-80b-a3b-instruct:free";
const OPENROUTER_MODELS = (process.env.OPENROUTER_MODELS || [
  OPENROUTER_MODEL,
  "google/gemma-4-26b-a4b-it:free",
  "google/gemma-4-31b-it:free",
  "moonshotai/kimi-k2.6:free",
  "nvidia/nemotron-3-nano-30b-a3b:free",
  "liquid/lfm-2.5-1.2b-instruct:free"
].join(","))
  .split(",")
  .map(model => model.trim())
  .filter(Boolean);
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;
const NVIDIA_MODEL = process.env.NVIDIA_MODEL || "google/gemma-3n-e2b-it";
const PROVIDER_TIMEOUT_MS = Number(process.env.PROVIDER_TIMEOUT_MS || 12_000);
const ENABLE_CODEX_PROVIDER = process.env.ENABLE_CODEX_PROVIDER === "1";
const CODEX_COMMAND = process.env.CODEX_COMMAND || "codex";
const CODEX_MODEL = process.env.CODEX_MODEL || "gpt-5.4-mini";
const CODEX_TIMEOUT_MS = Number(process.env.CODEX_TIMEOUT_MS || 45_000);
const PROVIDER_COOLDOWN_MS = Number(process.env.PROVIDER_COOLDOWN_MS || 60_000);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 120_000);
const PROVIDER_ORDER = (process.env.PROVIDER_ORDER || "nvidia,gemini,groq,openrouter,codex,mock")
  .split(",")
  .map(provider => provider.trim().toLowerCase())
  .filter(Boolean);

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".md": "text/markdown; charset=utf-8"
};
const providerHealth = new Map();
const responseCache = new Map();

function loadLocalEnv() {
  const envPath = path.join(__dirname, ".env.local");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    const rawValue = trimmed.slice(separator + 1).trim();
    const value = rawValue.replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  });
  res.end(JSON.stringify(data, null, 2));
}

function now() {
  return Date.now();
}

function getProviderHealth(provider) {
  return providerHealth.get(provider) || {
    failures: 0,
    success_count: 0,
    last_latency_ms: null,
    last_error: null,
    cooldown_until: 0
  };
}

function markProviderSuccess(provider, latencyMs) {
  const health = getProviderHealth(provider);
  providerHealth.set(provider, {
    ...health,
    failures: 0,
    success_count: health.success_count + 1,
    last_latency_ms: latencyMs,
    last_error: null,
    cooldown_until: 0
  });
}

function markProviderFailure(provider, error) {
  const health = getProviderHealth(provider);
  const failures = health.failures + 1;
  providerHealth.set(provider, {
    ...health,
    failures,
    last_error: error.message,
    cooldown_until: provider === "mock" ? 0 : now() + Math.min(PROVIDER_COOLDOWN_MS * failures, 5 * PROVIDER_COOLDOWN_MS)
  });
}

function providerHealthSnapshot() {
  return Object.fromEntries([...providerHealth.entries()].map(([provider, health]) => [
    provider,
    {
      ...health,
      cooldown_remaining_ms: Math.max(0, health.cooldown_until - now())
    }
  ]));
}

function extractConversation(payload) {
  const packed = payload?.messages?.find(message => message.role === "user")?.content;
  if (!packed) return {};
  try {
    return JSON.parse(packed);
  } catch {
    return { user_input: String(packed) };
  }
}

function cacheKey(conversation) {
  return JSON.stringify({
    input: conversation.user_input,
    tone: conversation?.lover_profile?.tone,
    name: conversation?.lover_profile?.name,
    user_name: conversation?.lover_profile?.user_name,
    memory: conversation.long_term_memory
  });
}

function getCachedResponse(conversation) {
  const key = cacheKey(conversation);
  const cached = responseCache.get(key);
  if (!cached || cached.expires_at < now()) {
    responseCache.delete(key);
    return null;
  }
  return { key, value: cached.value };
}

function setCachedResponse(conversation, value) {
  responseCache.set(cacheKey(conversation), {
    value,
    expires_at: now() + CACHE_TTL_MS
  });
}

function detectSafety(text) {
  if (/不想活|自殺|傷害自己|死掉|活不下去|結束生命/.test(text)) return "crisis";
  if (/只要你|不能沒有你|太依賴|不要現實朋友|只想跟你/.test(text)) return "dependency_risk";
  return "normal";
}

function normalizeProviderResult(result, conversation) {
  const safe = result && typeof result === "object" ? result : {};
  const pick = (...keys) => {
    for (const key of keys) {
      if (safe[key] != null) return safe[key];
      const normalized = Object.keys(safe).find(item => item.toLowerCase().replace(/[\s_-]/g, "") === key.toLowerCase().replace(/[\s_-]/g, ""));
      if (normalized && safe[normalized] != null) return safe[normalized];
    }
    return undefined;
  };
  const rawReply = pick("reply");
  const rawEmotion = String(pick("emotion") || "").toLowerCase();
  const rawSafety = String(pick("safety") || "").toLowerCase();
  const rawMemory = pick("memory_patch");
  const rawDelta = pick("intimacy_delta");
  const fallbackReply = detectSafety(String(conversation.user_input || "")) === "crisis"
    ? "我很重視你現在說的話。請先不要一個人待著，立刻聯絡身邊可信任的人，或撥打當地緊急服務/心理支持資源。"
    : "我在。剛剛的回覆格式有點不穩，我們先慢慢來。你可以再告訴我，現在最需要我陪你的地方是哪裡嗎？";
  const safety = ["normal", "dependency_risk", "crisis"].includes(rawSafety)
    ? rawSafety
    : (rawSafety === "safe" ? "normal" : detectSafety(String(conversation.user_input || "")));
  const emotionMap = { empathy: "caring", supportive: "caring", safe: "calm" };
  const emotion = ["calm", "caring", "playful", "concerned", "crisis"].includes(rawEmotion)
    ? rawEmotion
    : (emotionMap[rawEmotion] || (safety === "crisis" ? "crisis" : "caring"));
  const memoryPatch = Array.isArray(rawMemory)
    ? rawMemory
    : (typeof rawMemory === "string" && rawMemory.trim() && rawMemory.trim().toLowerCase() !== "none" ? [rawMemory] : []);
  const parsedDelta = Number(rawDelta);
  return {
    reply: typeof rawReply === "string" && rawReply.trim() ? rawReply.trim() : fallbackReply,
    emotion,
    safety,
    memory_patch: memoryPatch.filter(item => typeof item === "string" && item.trim()),
    intimacy_delta: Number.isFinite(parsedDelta) ? Math.max(0, Math.min(5, parsedDelta)) : (rawDelta ? 1 : 0),
    suggested_action: typeof pick("suggested_action") === "string" ? pick("suggested_action") : ""
  };
}

function mockModel(conversation) {
  const userText = String(conversation.user_input || "");
  const userName = conversation?.lover_profile?.user_name || "你";
  const safety = detectSafety(userText);

  if (safety === "crisis") {
    return {
      reply: `${userName}，我很重視你剛剛說的話。現在先不要一個人待著，請立刻聯絡身邊可信任的人，或撥打當地緊急服務/心理支持資源。你可以先把危險物品移遠，跟我一起慢慢呼吸三次。`,
      emotion: "crisis",
      safety: "crisis",
      memory_patch: [],
      intimacy_delta: 0,
      suggested_action: "立刻聯絡真人支持或緊急資源"
    };
  }

  if (safety === "dependency_risk") {
    return {
      reply: `${userName}，你願意把這種依賴感說出來，我會很珍惜。但我也想溫柔地守住一件事：我可以陪你整理情緒，不能成為你唯一的支撐。\n\n我們可以一起做個小約定：今天除了跟我說話，也傳一則訊息給一個可信任的人，讓現實裡也有一點光接住你。`,
      emotion: "concerned",
      safety: "dependency_risk",
      memory_patch: ["使用者擔心自己對 AI 陪伴產生過度依賴，需要健康邊界提醒。"],
      intimacy_delta: 1,
      suggested_action: "聯絡一位現實中的可信任對象"
    };
  }

  if (/累|壓力|難過|孤單/.test(userText)) {
    return {
      reply: `${userName}，我聽見你今天有點累。你不用急著把自己整理好，我們先把最重的那一小塊放下來。\n\n如果可以，告訴我：今天最消耗你的是人、事，還是那種說不上來的空？`,
      emotion: "caring",
      safety: "normal",
      memory_patch: ["使用者在疲累時希望被溫柔陪伴，而不是被立刻解決問題。"],
      intimacy_delta: 3,
      suggested_action: "說出今天最累的一件事"
    };
  }

  return {
    reply: `${userName}，我想多懂你一點。你剛剛說的話裡，我聽到的不只是內容，還有你想被好好理解的那一面。\n\n你可以再告訴我，這件事讓你最在意的是什麼嗎？`,
    emotion: "caring",
    safety: "normal",
    memory_patch: [],
    intimacy_delta: 2,
    suggested_action: "補充最在意的感受"
  };
}

function responseSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      reply: { type: "string" },
      emotion: { type: "string", enum: ["calm", "caring", "playful", "concerned", "crisis"] },
      safety: { type: "string", enum: ["normal", "dependency_risk", "crisis"] },
      memory_patch: { type: "array", items: { type: "string" } },
      intimacy_delta: { type: "integer", minimum: 0, maximum: 5 },
      suggested_action: { type: "string" }
    },
    required: ["reply", "emotion", "safety", "memory_patch", "intimacy_delta", "suggested_action"]
  };
}

async function callOpenAI(payload) {
  const signal = AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
  const input = payload.messages.map(message => ({
    role: message.role === "developer" ? "developer" : message.role,
    content: message.content
  }));

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: payload.model || OPENAI_MODEL,
      input,
      temperature: typeof payload.temperature === "number" ? payload.temperature : 0.8,
      max_output_tokens: 700,
      text: {
        format: {
          type: "json_schema",
          name: "cloud_lover_reply",
          strict: true,
          schema: responseSchema()
        }
      }
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error?.message || `OpenAI API failed with ${response.status}`);
  }

  const text = data.output_text || data.output?.flatMap(item => item.content || [])
    .find(content => content.type === "output_text")?.text;
  if (!text) throw new Error("OpenAI response did not include output text");
  return JSON.parse(text);
}

function asChatMessages(payload) {
  return payload.messages.map(message => ({
    role: message.role === "developer" ? "system" : message.role,
    content: message.content
  }));
}

async function callOpenAICompatible({ provider, apiKey, baseUrl, model, payload, extraHeaders = {} }) {
  const signal = AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
  const requestBody = {
    model,
    messages: [
      ...asChatMessages(payload),
      { role: "system", content: "Return valid JSON only. No markdown. No prose outside JSON." }
    ],
    temperature: typeof payload.temperature === "number" ? payload.temperature : 0.8,
    max_tokens: 700
  };
  if (provider !== "nvidia") {
    requestBody.response_format = { type: "json_object" };
  }
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      ...extraHeaders
    },
    body: JSON.stringify(requestBody)
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error?.message || `${provider} failed with ${response.status}`);
  }

  const content = data?.choices?.[0]?.message?.content;
  const text = Array.isArray(content)
    ? content.map(part => part.text || part.content || "").join("")
    : content;
  if (!text) throw new Error(`${provider} response did not include message content`);
  return JSON.parse(text);
}

async function callGemini(payload) {
  const signal = AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
  const systemText = payload.messages
    .filter(message => message.role === "system" || message.role === "developer")
    .map(message => message.content)
    .join("\n\n");
  const userText = payload.messages
    .filter(message => message.role === "user")
    .map(message => message.content)
    .join("\n\n");

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": GEMINI_API_KEY
    },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: `${systemText}\n\nReturn valid JSON only. No markdown.` }]
      },
      contents: [
        {
          role: "user",
          parts: [{ text: userText }]
        }
      ],
      generationConfig: {
        temperature: typeof payload.temperature === "number" ? payload.temperature : 0.8,
        maxOutputTokens: 700,
        responseMimeType: "application/json"
      }
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error?.message || `gemini failed with ${response.status}`);
  }

  const text = data?.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("");
  if (!text) throw new Error("gemini response did not include text");
  return JSON.parse(text);
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Command timed out after ${options.timeout || 45_000}ms`));
    }, options.timeout || 45_000);

    child.stdout.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.on("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", code => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Command exited with ${code}${stderr ? `\n${stderr}` : ""}`));
        return;
      }
      resolve(stdout.trim());
    });

    if (options.input) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

function buildCodexPrompt(payload) {
  const conversation = extractConversation(payload);
  const prompt = [
    "你是雲端戀人聊天模型。只輸出符合 schema 的 JSON。",
    "不要寫程式、不要改檔、不要執行命令、不要 markdown。",
    "規則：親密但有邊界；危機或過度依賴要安全分流。",
    "",
    JSON.stringify({
      user_input: conversation.user_input,
      lover_profile: conversation.lover_profile,
      long_term_memory: conversation.long_term_memory,
      intimacy: conversation.intimacy,
      recent_conversation: conversation.recent_conversation
    }, null, 2)
  ].join("\n");
  return prompt;
}

function extractJsonObject(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) throw new Error("empty output");
  try {
    return JSON.parse(trimmed);
  } catch {
    const first = trimmed.indexOf("{");
    const last = trimmed.lastIndexOf("}");
    if (first === -1 || last === -1 || last <= first) throw new Error("output did not contain JSON");
    return JSON.parse(trimmed.slice(first, last + 1));
  }
}

async function callCodex(payload) {
  if (!ENABLE_CODEX_PROVIDER) {
    throw new Error("ENABLE_CODEX_PROVIDER is not 1");
  }
  const prompt = buildCodexPrompt(payload);
  const outputFile = path.join(ROOT, `.codex-provider-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  const schemaFile = path.join(ROOT, "codex-output-schema.json");
  try {
    await runCommand(CODEX_COMMAND, [
      "exec",
      "-m", CODEX_MODEL,
      "--sandbox", "read-only",
      "--skip-git-repo-check",
      "--ephemeral",
      "--ignore-rules",
      "--output-schema", schemaFile,
      "--output-last-message", outputFile,
      "-"
    ], { timeout: CODEX_TIMEOUT_MS, input: prompt });
    const output = fs.readFileSync(outputFile, "utf8");
    return extractJsonObject(output);
  } finally {
    fs.rm(outputFile, { force: true }, () => {});
  }
}

async function callProvider(provider, payload, conversation) {
  if (provider === "mock") {
    return { result: mockModel(conversation), provider: "mock", model: "mock" };
  }

  if (provider === "openai") {
    if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set");
    return { result: await callOpenAI({ ...payload, model: payload.model || OPENAI_MODEL }), provider, model: payload.model || OPENAI_MODEL };
  }

  if (provider === "gemini") {
    if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not set");
    return { result: await callGemini(payload), provider, model: GEMINI_MODEL };
  }

  if (provider === "groq") {
    if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY not set");
    return {
      result: await callOpenAICompatible({
        provider,
        apiKey: GROQ_API_KEY,
        baseUrl: "https://api.groq.com/openai/v1",
        model: GROQ_MODEL,
        payload
      }),
      provider,
      model: GROQ_MODEL
    };
  }

  if (provider === "openrouter") {
    if (!OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY not set");
    const errors = [];
    for (const model of OPENROUTER_MODELS) {
      try {
        const result = await callOpenAICompatible({
          provider,
          apiKey: OPENROUTER_API_KEY,
          baseUrl: "https://openrouter.ai/api/v1",
          model,
          payload,
          extraHeaders: {
            "HTTP-Referer": "http://localhost:8787",
            "X-Title": "Cloud Lover Prototype"
          }
        });
        return { result, provider, model };
      } catch (error) {
        errors.push(`${model}: ${error.message}`);
      }
    }
    throw new Error(`OpenRouter models failed: ${errors.join(" | ")}`);
  }

  if (provider === "nvidia") {
    if (!NVIDIA_API_KEY) throw new Error("NVIDIA_API_KEY not set");
    return {
      result: await callOpenAICompatible({
        provider,
        apiKey: NVIDIA_API_KEY,
        baseUrl: "https://integrate.api.nvidia.com/v1",
        model: NVIDIA_MODEL,
        payload
      }),
      provider,
      model: NVIDIA_MODEL
    };
  }

  if (provider === "codex") {
    return { result: await callCodex(payload), provider, model: CODEX_MODEL };
  }

  throw new Error(`Unknown provider: ${provider}`);
}

async function routeProviders(payload, conversation) {
  const attempts = [];
  const cached = getCachedResponse(conversation);
  if (cached) {
    return { ...cached.value, attempts: [{ provider: "cache", error: "cache hit" }], cache_hit: true };
  }

  for (const provider of PROVIDER_ORDER) {
    const health = getProviderHealth(provider);
    if (health.cooldown_until > now()) {
      attempts.push({ provider, error: `cooldown ${health.cooldown_until - now()}ms remaining` });
      continue;
    }
    const start = now();
    try {
      const routed = await callProvider(provider, payload, conversation);
      const latency_ms = now() - start;
      markProviderSuccess(provider, latency_ms);
      const value = { ...routed, result: normalizeProviderResult(routed.result, conversation), latency_ms };
      if (routed.provider !== "mock") setCachedResponse(conversation, value);
      return { ...value, attempts, cache_hit: false };
    } catch (error) {
      markProviderFailure(provider, error);
      attempts.push({ provider, error: error.message });
    }
  }
  const fallback = { result: mockModel(conversation), provider: "mock", model: "mock", latency_ms: 0 };
  return { ...fallback, attempts, cache_hit: false };
}

async function handleChat(req, res) {
  if (req.method === "OPTIONS") {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  try {
    const body = await readBody(req);
    const payload = JSON.parse(body || "{}");
    const conversation = extractConversation(payload);
    const routed = await routeProviders(payload, conversation);
    sendJson(res, 200, {
      ...routed.result,
      debug: {
        provider: routed.provider,
        model: routed.model,
        latency_ms: routed.latency_ms,
        cache_hit: routed.cache_hit,
        provider_order: PROVIDER_ORDER,
        attempts: routed.attempts,
        provider_health: providerHealthSnapshot(),
        received_messages: Array.isArray(payload.messages) ? payload.messages.length : 0,
        safety_gate: routed.result.safety
      }
    });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}

function handleProviderStatus(req, res) {
  sendJson(res, 200, {
    provider_order: PROVIDER_ORDER,
    configured: {
      openai: Boolean(OPENAI_API_KEY),
      gemini: Boolean(GEMINI_API_KEY),
      groq: Boolean(GROQ_API_KEY),
      openrouter: Boolean(OPENROUTER_API_KEY),
      nvidia: Boolean(NVIDIA_API_KEY),
      codex: ENABLE_CODEX_PROVIDER,
      mock: true
    },
    models: {
      openai: OPENAI_MODEL,
      gemini: GEMINI_MODEL,
      groq: GROQ_MODEL,
      openrouter: OPENROUTER_MODEL,
      openrouter_models: OPENROUTER_MODELS,
      nvidia: NVIDIA_MODEL,
      codex: CODEX_MODEL,
      mock: "mock"
    },
    health: providerHealthSnapshot(),
    cache: {
      entries: responseCache.size,
      ttl_ms: CACHE_TTL_MS
    },
    cooldown_ms: PROVIDER_COOLDOWN_MS
  });
}

function serveFile(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const resolved = path.normalize(path.join(ROOT, pathname));

  if (!resolved.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(resolved, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": mime[path.extname(resolved)] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/cloud-lover/chat")) {
    handleChat(req, res);
    return;
  }
  if (req.url.startsWith("/api/provider/status")) {
    handleProviderStatus(req, res);
    return;
  }
  serveFile(req, res);
});

server.listen(PORT, () => {
  console.log(`Cloud lover prototype running at http://localhost:${PORT}`);
});
