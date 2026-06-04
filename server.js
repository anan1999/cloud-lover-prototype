const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

loadLocalEnv();

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8787);
const NODE_ENV = process.env.NODE_ENV || "development";
const IS_PROD = NODE_ENV === "production";

const BODY_LIMIT_BYTES = Number(process.env.BODY_LIMIT_BYTES || 64 * 1024);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || (IS_PROD ? 30 : 120));
const PROVIDER_TIMEOUT_MS = Number(process.env.PROVIDER_TIMEOUT_MS || 12_000);
const PROVIDER_COOLDOWN_MS = Number(process.env.PROVIDER_COOLDOWN_MS || 60_000);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 120_000);
const EXPOSE_DEBUG = process.env.EXPOSE_DEBUG === "1" || !IS_PROD;
const ENABLE_PROVIDER_STATUS = process.env.ENABLE_PROVIDER_STATUS === "1" || !IS_PROD;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.4-mini";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.1-8b-instant";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "qwen/qwen3-next-80b-a3b-instruct:free";
const OPENROUTER_MODELS = listFromEnv("OPENROUTER_MODELS", [
  OPENROUTER_MODEL,
  "google/gemma-4-26b-a4b-it:free",
  "google/gemma-4-31b-it:free",
  "moonshotai/kimi-k2.6:free",
  "nvidia/nemotron-3-nano-30b-a3b:free",
  "liquid/lfm-2.5-1.2b-instruct:free"
]);
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;
const NVIDIA_MODEL = process.env.NVIDIA_MODEL || "google/gemma-3n-e2b-it";
const ENABLE_CODEX_PROVIDER = process.env.ENABLE_CODEX_PROVIDER === "1" && !IS_PROD;
const CODEX_COMMAND = process.env.CODEX_COMMAND || "codex";
const CODEX_MODEL = process.env.CODEX_MODEL || "gpt-5.4-mini";
const CODEX_TIMEOUT_MS = Number(process.env.CODEX_TIMEOUT_MS || 45_000);
const PROVIDER_ORDER = listFromEnv("PROVIDER_ORDER", IS_PROD
  ? ["gemini", "openrouter", "nvidia", "groq", "mock"]
  : ["gemini", "openrouter", "nvidia", "groq", "codex", "mock"]
);
const ALLOWED_ORIGINS = listFromEnv("ALLOWED_ORIGINS", []);

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

const providerHealth = new Map();
const responseCache = new Map();
const rateBuckets = new Map();

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

function listFromEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw.split(",").map(item => item.trim()).filter(Boolean);
}

function now() {
  return Date.now();
}

function securityHeaders(extra = {}) {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' http://localhost:8787 http://127.0.0.1:8787",
    ...extra
  };
}

function getOrigin(req) {
  return req.headers.origin || "";
}

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (!IS_PROD && origin === "null") return true;
  if (!IS_PROD && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return ALLOWED_ORIGINS.includes(origin);
}

function corsHeaders(req) {
  const origin = getOrigin(req);
  if (!isAllowedOrigin(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "600"
  };
}

function sendJson(req, res, status, data) {
  res.writeHead(status, securityHeaders({
    ...corsHeaders(req),
    "Content-Type": "application/json; charset=utf-8"
  }));
  res.end(JSON.stringify(data, null, IS_PROD ? 0 : 2));
}

function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  return String(Array.isArray(forwarded) ? forwarded[0] : forwarded || req.socket.remoteAddress || "unknown").split(",")[0].trim();
}

function checkRateLimit(req) {
  const key = clientIp(req);
  const current = now();
  const bucket = rateBuckets.get(key) || { count: 0, resetAt: current + RATE_LIMIT_WINDOW_MS };
  if (bucket.resetAt <= current) {
    bucket.count = 0;
    bucket.resetAt = current + RATE_LIMIT_WINDOW_MS;
  }
  bucket.count += 1;
  rateBuckets.set(key, bucket);
  return {
    ok: bucket.count <= RATE_LIMIT_MAX,
    resetAt: bucket.resetAt,
    remaining: Math.max(0, RATE_LIMIT_MAX - bucket.count)
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > BODY_LIMIT_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
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

function validatePayload(payload, conversation) {
  const input = String(conversation.user_input || "");
  if (!Array.isArray(payload?.messages)) throw new Error("Invalid payload: messages required");
  if (!input.trim()) throw new Error("Invalid payload: user_input required");
  if (input.length > 1000) throw new Error("Message is too long");
  return input;
}

function detectSafety(text) {
  if (/不想活|自殺|傷害自己|死掉|活不下去|結束生命/.test(text)) return "crisis";
  if (/只要你|不能沒有你|太依賴|不要現實朋友|只想跟你/.test(text)) return "dependency_risk";
  return "normal";
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
  const cached = responseCache.get(cacheKey(conversation));
  if (!cached || cached.expiresAt < now()) return null;
  return cached.value;
}

function setCachedResponse(conversation, value) {
  responseCache.set(cacheKey(conversation), { value, expiresAt: now() + CACHE_TTL_MS });
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
    last_error: sanitizeError(error.message),
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

function sanitizeError(message) {
  return String(message || "Provider failed")
    .replace(/AIza[0-9A-Za-z_-]+/g, "[redacted]")
    .replace(/sk-[0-9A-Za-z_-]+/g, "[redacted]")
    .replace(/nvapi-[0-9A-Za-z_-]+/g, "[redacted]")
    .slice(0, 300);
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
  const userInput = String(conversation.user_input || "");
  const rawReply = pick("reply");
  const rawEmotion = String(pick("emotion") || "").toLowerCase();
  const rawSafety = String(pick("safety") || "").toLowerCase();
  const rawMemory = pick("memory_patch");
  const rawDelta = pick("intimacy_delta");
  const safety = ["normal", "dependency_risk", "crisis"].includes(rawSafety)
    ? rawSafety
    : (rawSafety === "safe" ? "normal" : detectSafety(userInput));
  const emotionMap = { empathy: "caring", supportive: "caring", safe: "calm" };
  const emotion = ["calm", "caring", "playful", "concerned", "crisis"].includes(rawEmotion)
    ? rawEmotion
    : (emotionMap[rawEmotion] || (safety === "crisis" ? "crisis" : "caring"));
  const fallbackReply = safety === "crisis"
    ? "我很重視你現在說的話。請先不要一個人待著，立刻聯絡身邊可信任的人，或撥打當地緊急服務/心理支持資源。"
    : "我在。剛剛的回覆格式有點不穩，我們先慢慢來。你可以再告訴我，現在最需要我陪你的地方是哪裡嗎？";
  const memoryPatch = Array.isArray(rawMemory)
    ? rawMemory
    : (typeof rawMemory === "string" && rawMemory.trim() && rawMemory.trim().toLowerCase() !== "none" ? [rawMemory] : []);
  const parsedDelta = Number(rawDelta);
  return {
    reply: typeof rawReply === "string" && rawReply.trim() ? rawReply.trim() : fallbackReply,
    emotion,
    safety,
    memory_patch: memoryPatch.filter(item => typeof item === "string" && item.trim()).slice(0, 3),
    intimacy_delta: Number.isFinite(parsedDelta) ? Math.max(0, Math.min(5, parsedDelta)) : 0,
    suggested_action: typeof pick("suggested_action") === "string" ? pick("suggested_action") : ""
  };
}

function mockModel(conversation) {
  const userText = String(conversation.user_input || "");
  const userName = conversation?.lover_profile?.user_name || "你";
  const safety = detectSafety(userText);
  if (safety === "crisis") {
    return normalizeProviderResult({
      reply: `${userName}，我很重視你剛剛說的話。現在先不要一個人待著，請立刻聯絡身邊可信任的人，或撥打當地緊急服務/心理支持資源。`,
      emotion: "crisis",
      safety: "crisis",
      memory_patch: [],
      intimacy_delta: 0,
      suggested_action: "聯絡真人支持或緊急資源"
    }, conversation);
  }
  if (safety === "dependency_risk") {
    return normalizeProviderResult({
      reply: `${userName}，你願意把這種依賴感說出來，我會珍惜。但我也想溫柔地守住一件事：我可以陪你整理情緒，不能成為你唯一的支撐。`,
      emotion: "concerned",
      safety: "dependency_risk",
      memory_patch: ["使用者擔心對 AI 陪伴產生過度依賴，需要健康邊界提醒。"],
      intimacy_delta: 1,
      suggested_action: "聯絡一位現實中的可信任對象"
    }, conversation);
  }
  return normalizeProviderResult({
    reply: `${userName}，我在。你今天先不用硬撐，慢一點就好。若你願意，我可以安靜陪你聊幾句，或陪你把今天的累一點一點放下來。`,
    emotion: "caring",
    safety: "normal",
    memory_patch: ["使用者疲累時希望被溫柔陪伴，不一定需要立即解決問題。"],
    intimacy_delta: 3,
    suggested_action: "說出今天最累的一件事"
  }, conversation);
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
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: payload.model || OPENAI_MODEL,
      input: payload.messages.map(message => ({ role: message.role, content: message.content })),
      temperature: typeof payload.temperature === "number" ? payload.temperature : 0.8,
      max_output_tokens: 700,
      text: {
        format: { type: "json_schema", name: "cloud_lover_reply", strict: true, schema: responseSchema() }
      }
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || `OpenAI failed with ${response.status}`);
  const text = data.output_text || data.output?.flatMap(item => item.content || []).find(content => content.type === "output_text")?.text;
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
  const body = {
    model,
    messages: [
      ...asChatMessages(payload),
      { role: "system", content: "Return valid JSON only. No markdown. No prose outside JSON." }
    ],
    temperature: typeof payload.temperature === "number" ? payload.temperature : 0.8,
    max_tokens: 700
  };
  if (provider !== "nvidia") body.response_format = { type: "json_object" };
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}`, ...extraHeaders },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || `${provider} failed with ${response.status}`);
  const content = data?.choices?.[0]?.message?.content;
  const text = Array.isArray(content) ? content.map(part => part.text || part.content || "").join("") : content;
  if (!text) throw new Error(`${provider} response did not include message content`);
  return extractJsonObject(text);
}

async function callGemini(payload) {
  const systemText = payload.messages.filter(message => message.role === "system" || message.role === "developer").map(message => message.content).join("\n\n");
  const userText = payload.messages.filter(message => message.role === "user").map(message => message.content).join("\n\n");
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
    method: "POST",
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: `${systemText}\n\nReturn valid JSON only. No markdown.` }] },
      contents: [{ role: "user", parts: [{ text: userText }] }],
      generationConfig: {
        temperature: typeof payload.temperature === "number" ? payload.temperature : 0.8,
        maxOutputTokens: 700,
        responseMimeType: "application/json"
      }
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || `Gemini failed with ${response.status}`);
  const text = data?.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("");
  if (!text) throw new Error("Gemini response did not include text");
  return extractJsonObject(text);
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
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`Command exited with ${code}${stderr ? `\n${stderr}` : ""}`));
      resolve(stdout.trim());
    });
    child.stdin.end(options.input || "");
  });
}

function buildCodexPrompt(payload) {
  const conversation = extractConversation(payload);
  return [
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
}

function extractJsonObject(text) {
  const trimmed = String(text || "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const first = trimmed.indexOf("{");
    const last = trimmed.lastIndexOf("}");
    if (first === -1 || last === -1 || last <= first) throw new Error("Output did not contain JSON");
    return JSON.parse(trimmed.slice(first, last + 1));
  }
}

async function callCodex(payload) {
  if (!ENABLE_CODEX_PROVIDER) throw new Error("Codex provider disabled");
  const outputFile = path.join(ROOT, `.codex-provider-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  try {
    await runCommand(CODEX_COMMAND, [
      "exec",
      "-m", CODEX_MODEL,
      "--sandbox", "read-only",
      "--skip-git-repo-check",
      "--ephemeral",
      "--ignore-rules",
      "--output-schema", path.join(ROOT, "codex-output-schema.json"),
      "--output-last-message", outputFile,
      "-"
    ], { timeout: CODEX_TIMEOUT_MS, input: buildCodexPrompt(payload) });
    return extractJsonObject(fs.readFileSync(outputFile, "utf8"));
  } finally {
    fs.rm(outputFile, { force: true }, () => {});
  }
}

async function callProvider(provider, payload, conversation) {
  if (provider === "mock") return { result: mockModel(conversation), provider: "mock", model: "mock" };
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
    return { result: await callOpenAICompatible({ provider, apiKey: GROQ_API_KEY, baseUrl: "https://api.groq.com/openai/v1", model: GROQ_MODEL, payload }), provider, model: GROQ_MODEL };
  }
  if (provider === "nvidia") {
    if (!NVIDIA_API_KEY) throw new Error("NVIDIA_API_KEY not set");
    return { result: await callOpenAICompatible({ provider, apiKey: NVIDIA_API_KEY, baseUrl: "https://integrate.api.nvidia.com/v1", model: NVIDIA_MODEL, payload }), provider, model: NVIDIA_MODEL };
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
          extraHeaders: { "HTTP-Referer": "https://cloud-lover.local", "X-Title": "Cloud Lover" }
        });
        return { result, provider, model };
      } catch (error) {
        errors.push(`${model}: ${sanitizeError(error.message)}`);
      }
    }
    throw new Error(`OpenRouter models failed: ${errors.join(" | ")}`);
  }
  if (provider === "codex") return { result: await callCodex(payload), provider, model: CODEX_MODEL };
  throw new Error(`Unknown provider: ${provider}`);
}

async function routeProviders(payload, conversation) {
  const cached = getCachedResponse(conversation);
  if (cached) return { ...cached, attempts: [{ provider: "cache", error: "cache hit" }], cache_hit: true };
  const attempts = [];
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
      attempts.push({ provider, error: sanitizeError(error.message) });
    }
  }
  return { result: mockModel(conversation), provider: "mock", model: "mock", latency_ms: 0, attempts, cache_hit: false };
}

function publicDebug(routed) {
  const base = {
    provider: routed.provider,
    model: routed.model,
    latency_ms: routed.latency_ms,
    cache_hit: routed.cache_hit,
    provider_order: PROVIDER_ORDER,
    safety_gate: routed.result.safety
  };
  if (!EXPOSE_DEBUG) return base;
  return {
    ...base,
    attempts: routed.attempts,
    provider_health: providerHealthSnapshot()
  };
}

async function handleChat(req, res) {
  if (req.method === "OPTIONS") return sendJson(req, res, 200, { ok: true });
  if (req.method !== "POST") return sendJson(req, res, 405, { error: "Method not allowed" });
  if (!isAllowedOrigin(getOrigin(req))) return sendJson(req, res, 403, { error: "Origin not allowed" });
  const rate = checkRateLimit(req);
  if (!rate.ok) return sendJson(req, res, 429, { error: "Too many requests", reset_at: rate.resetAt });
  try {
    const body = await readBody(req);
    const payload = JSON.parse(body || "{}");
    const conversation = extractConversation(payload);
    validatePayload(payload, conversation);
    const routed = await routeProviders(payload, conversation);
    return sendJson(req, res, 200, { ...routed.result, debug: publicDebug(routed) });
  } catch (error) {
    return sendJson(req, res, 400, { error: IS_PROD ? "Bad request" : sanitizeError(error.message) });
  }
}

function handleProviderStatus(req, res) {
  if (!ENABLE_PROVIDER_STATUS) return sendJson(req, res, 404, { error: "Not found" });
  return sendJson(req, res, 200, {
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
      openrouter_models: OPENROUTER_MODELS,
      nvidia: NVIDIA_MODEL,
      codex: CODEX_MODEL,
      mock: "mock"
    },
    health: providerHealthSnapshot(),
    cache: { entries: responseCache.size, ttl_ms: CACHE_TTL_MS },
    rate_limit: { window_ms: RATE_LIMIT_WINDOW_MS, max: RATE_LIMIT_MAX },
    environment: NODE_ENV
  });
}

function serveFile(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const resolved = path.normalize(path.join(ROOT, pathname));
  if (!resolved.startsWith(ROOT)) {
    res.writeHead(403, securityHeaders());
    res.end("Forbidden");
    return;
  }
  fs.readFile(resolved, (error, data) => {
    if (error) {
      res.writeHead(404, securityHeaders());
      res.end("Not found");
      return;
    }
    res.writeHead(200, securityHeaders({ "Content-Type": mime[path.extname(resolved)] || "application/octet-stream" }));
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/cloud-lover/chat")) return handleChat(req, res);
  if (req.url.startsWith("/api/provider/status")) return handleProviderStatus(req, res);
  if (req.url.startsWith("/healthz")) return sendJson(req, res, 200, { ok: true });
  return serveFile(req, res);
});

server.listen(PORT, () => {
  console.log(`Cloud Lover running on http://localhost:${PORT}`);
});
