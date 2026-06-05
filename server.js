const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");

loadLocalEnv();

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8787);
const NODE_ENV = process.env.NODE_ENV || "development";
const IS_PROD = NODE_ENV === "production";

const BODY_LIMIT_BYTES = Number(process.env.BODY_LIMIT_BYTES || 64 * 1024);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || (IS_PROD ? 30 : 120));
const PROVIDER_TIMEOUT_MS = Number(process.env.PROVIDER_TIMEOUT_MS || 12_000);
const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || PROVIDER_TIMEOUT_MS);
const PROVIDER_COOLDOWN_MS = Number(process.env.PROVIDER_COOLDOWN_MS || 60_000);
const MOCK_FALLBACK_DELAY_MS = Number(process.env.MOCK_FALLBACK_DELAY_MS || (IS_PROD ? 60_000 : 0));
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 120_000);
const NEWS_CACHE_TTL_MS = Number(process.env.NEWS_CACHE_TTL_MS || 15 * 60_000);
const EXPOSE_DEBUG = process.env.EXPOSE_DEBUG === "1" || !IS_PROD;
const ENABLE_PROVIDER_STATUS = process.env.ENABLE_PROVIDER_STATUS === "1" || !IS_PROD;
const DATABASE_URL = process.env.DATABASE_URL;
const SESSION_COOKIE = "cloud_lover_session";
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 1000 * 60 * 60 * 24 * 30);
const PASSWORD_MIN_LENGTH = Number(process.env.PASSWORD_MIN_LENGTH || 8);
const ADMIN_EMAILS = listFromEnv("ADMIN_EMAILS", []).map(email => email.toLowerCase());

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
const ENABLE_CODEX_PROVIDER = process.env.ENABLE_CODEX_PROVIDER === "1";
const ENABLE_MOCK_FALLBACK = process.env.ENABLE_MOCK_FALLBACK === "1" || (!IS_PROD && process.env.ENABLE_MOCK_FALLBACK !== "0");
const CODEX_COMMAND = process.env.CODEX_COMMAND || "codex";
const CODEX_MODEL = process.env.CODEX_MODEL || "gpt-5.5";
const CODEX_TIMEOUT_MS = Number(process.env.CODEX_TIMEOUT_MS || 60_000);
const CODEX_BACKEND = process.env.CODEX_BACKEND || "api";
const CODEX_API_KEY = process.env.CODEX_API_KEY || OPENAI_API_KEY;
const CODEX_WORKER_URL = process.env.CODEX_WORKER_URL || "";
const CODEX_WORKER_TOKEN = process.env.CODEX_WORKER_TOKEN || "";
const RAW_PROVIDER_ORDER = listFromEnv("PROVIDER_ORDER", IS_PROD
  ? ["gemini", "codex", "mock"]
  : ["gemini", "openrouter", "nvidia", "groq", "codex", "mock"]
);
const PROVIDER_ORDER = RAW_PROVIDER_ORDER.filter(provider => {
  if (provider === "mock") return ENABLE_MOCK_FALLBACK;
  if (provider === "codex") return ENABLE_CODEX_PROVIDER;
  return true;
});
const ALLOWED_ORIGINS = listFromEnv("ALLOWED_ORIGINS", []);
const NEWS_RSS_URLS = listFromEnv("NEWS_RSS_URLS", [
  "https://news.google.com/rss?hl=zh-TW&gl=TW&ceid=TW:zh-Hant"
]);

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
let newsCache = { expiresAt: 0, items: [] };
const webFactCache = new Map();
const rateBuckets = new Map();
const localDbPath = path.join(ROOT, ".local-db.json");
let pgPool = null;
let dbReady = null;

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

function isAllowedOrigin(req, origin) {
  if (!origin) return true;
  if (!IS_PROD && origin === "null") return true;
  if (!IS_PROD && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  try {
    const originUrl = new URL(origin);
    const host = String(req.headers.host || "").toLowerCase();
    if (host && originUrl.host.toLowerCase() === host) return true;
  } catch {
    return false;
  }
  return ALLOWED_ORIGINS.includes(origin);
}

function corsHeaders(req) {
  const origin = getOrigin(req);
  if (!isAllowedOrigin(req, origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Credentials": "true",
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

function readLocalDb() {
  if (!fs.existsSync(localDbPath)) {
    return { users: [], sessions: [], profiles: [], messages: [], memories: [], emotion_events: [], character_relationships: [] };
  }
  try {
    const db = JSON.parse(fs.readFileSync(localDbPath, "utf8"));
    return { users: [], sessions: [], profiles: [], messages: [], memories: [], emotion_events: [], character_relationships: [], ...db };
  } catch {
  return { users: [], sessions: [], profiles: [], messages: [], memories: [], emotion_events: [], character_relationships: [] };
  }
}

function writeLocalDb(db) {
  fs.writeFileSync(localDbPath, JSON.stringify(db, null, 2));
}

async function getPgPool() {
  if (!DATABASE_URL) return null;
  if (pgPool) return pgPool;
  const { Pool } = require("pg");
  pgPool = new Pool({
    connectionString: DATABASE_URL,
    ssl: IS_PROD ? { rejectUnauthorized: false } : undefined
  });
  return pgPool;
}

async function queryDb(sql, params = []) {
  const pool = await getPgPool();
  if (!pool) return null;
  return pool.query(sql, params);
}

async function initDb() {
  if (!DATABASE_URL) {
    const db = readLocalDb();
    writeLocalDb(db);
    return;
  }
  await queryDb(`
    create table if not exists users (
      id text primary key,
      email text unique not null,
      display_name text not null,
      password_hash text not null,
      salt text not null,
      created_at timestamptz not null default now()
    );
    create table if not exists sessions (
      token_hash text primary key,
      user_id text not null references users(id) on delete cascade,
      expires_at timestamptz not null,
      created_at timestamptz not null default now()
    );
    create table if not exists profiles (
      user_id text primary key references users(id) on delete cascade,
      lover_name text not null default 'Samantha',
      user_name text not null default '你',
      tone text not null default 'gentle',
      companion_mode text not null default 'casual_chat',
      intimacy integer not null default 42,
      updated_at timestamptz not null default now()
    );
    create table if not exists character_relationships (
      user_id text not null references users(id) on delete cascade,
      character_key text not null,
      lover_name text not null,
      intimacy integer not null default 35,
      trust integer not null default 30,
      conversation_count integer not null default 0,
      last_emotion text,
      updated_at timestamptz not null default now(),
      primary key (user_id, character_key)
    );
    create table if not exists messages (
      id text primary key,
      user_id text not null references users(id) on delete cascade,
      role text not null,
      content text not null,
      safety text,
      emotion text,
      provider text,
      created_at timestamptz not null default now()
    );
    alter table messages add column if not exists emotion_intensity integer;
    alter table messages add column if not exists emotional_need text;
    alter table messages add column if not exists emotion_valence text;
    alter table messages add column if not exists character_key text;
    alter table messages add column if not exists lover_name text;
    alter table profiles add column if not exists companion_mode text not null default 'casual_chat';
    create table if not exists memories (
      id text primary key,
      user_id text not null references users(id) on delete cascade,
      content text not null,
      created_at timestamptz not null default now()
    );
    create table if not exists emotion_events (
      id text primary key,
      user_id text not null references users(id) on delete cascade,
      message_id text references messages(id) on delete set null,
      primary_emotion text not null,
      intensity integer not null,
      emotional_need text not null,
      valence text not null,
      signals jsonb not null default '[]'::jsonb,
      sample text,
      created_at timestamptz not null default now()
    );
    create index if not exists messages_user_created_idx on messages(user_id, created_at);
    create index if not exists messages_user_character_created_idx on messages(user_id, character_key, created_at);
    create index if not exists memories_user_created_idx on memories(user_id, created_at);
    create index if not exists emotion_events_user_created_idx on emotion_events(user_id, created_at);
    create index if not exists emotion_events_emotion_idx on emotion_events(primary_emotion, created_at);
    create index if not exists character_relationships_updated_idx on character_relationships(user_id, updated_at);
  `);
}

async function ensureDb() {
  if (!dbReady) dbReady = initDb().catch(error => {
    dbReady = null;
    throw error;
  });
  return dbReady;
}

function uid() {
  return crypto.randomUUID();
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(password, salt, 210000, 32, "sha256").toString("hex");
  return { salt, hash };
}

function verifyPassword(password, user) {
  const hashed = hashPassword(password, user.salt).hash;
  return crypto.timingSafeEqual(Buffer.from(hashed, "hex"), Buffer.from(user.password_hash, "hex"));
}

function tokenHash(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || "").split(";").map(item => {
    const [key, ...parts] = item.trim().split("=");
    return [key, decodeURIComponent(parts.join("=") || "")];
  }).filter(([key]) => key));
}

function setSessionCookie(req, res, token) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  const secure = IS_PROD ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`);
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${IS_PROD ? "; Secure" : ""}`);
}

function publicUser(user) {
  if (!user) return null;
  return { id: user.id, email: user.email, display_name: user.display_name, is_admin: isAdminUser(user), created_at: user.created_at || null };
}

function isAdminUser(user) {
  return Boolean(user?.email && ADMIN_EMAILS.includes(String(user.email).toLowerCase()));
}

function validateEmail(email) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error("Invalid email");
  return normalized.slice(0, 160);
}

function validatePassword(password) {
  const value = String(password || "");
  if (value.length < PASSWORD_MIN_LENGTH) throw new Error(`Password must be at least ${PASSWORD_MIN_LENGTH} characters`);
  if (value.length > 128) throw new Error("Password is too long");
  return value;
}

function cleanText(value, max = 500) {
  return String(value || "").trim().slice(0, max);
}

function decodeHtmlEntities(text) {
  return String(text || "")
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function tagText(xml, tag) {
  const match = String(xml || "").match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? cleanText(decodeHtmlEntities(match[1]), 500) : "";
}

function parseRssItems(xml, limit = 8) {
  return [...String(xml || "").matchAll(/<item\b[\s\S]*?<\/item>/gi)]
    .slice(0, limit)
    .map(match => {
      const block = match[0];
      const title = tagText(block, "title");
      const link = tagText(block, "link");
      const source = tagText(block, "source");
      const published_at = tagText(block, "pubDate");
      return title ? { title, link, source, published_at } : null;
    })
    .filter(Boolean);
}

async function getCurrentNews(limit = 5) {
  const now = Date.now();
  if (newsCache.expiresAt > now && newsCache.items.length) return newsCache.items.slice(0, limit);
  const items = [];
  for (const url of NEWS_RSS_URLS) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (!response.ok) continue;
      items.push(...parseRssItems(await response.text(), limit));
    } catch {
      continue;
    }
    if (items.length >= limit) break;
  }
  newsCache = { expiresAt: now + NEWS_CACHE_TTL_MS, items: items.slice(0, 12) };
  return newsCache.items.slice(0, limit);
}

function wantsWebLookup(input) {
  return /是誰|是什麼人|你知道.*嗎|查一下|搜尋|最新|目前|現在|哪一年|什麼時候|誰是|誰/.test(String(input || ""));
}

function extractLookupQuery(input) {
  return cleanText(input, 80)
    .replace(/^(請|可以|幫我|你可以|麻煩你)?(先)?(查一下|搜尋一下|搜尋|查|告訴我|說說)?/u, "")
    .replace(/你知道/u, "")
    .replace(/是誰|是什麼人|是什麼|誰是|嗎|呢|？|\?/gu, "")
    .trim();
}

async function getWebFacts(input) {
  const query = extractLookupQuery(input);
  if (!query || query.length < 2) return [];
  const cached = webFactCache.get(query);
  if (cached && cached.expiresAt > Date.now()) return cached.items;
  try {
    const searchUrl = `https://zh.wikipedia.org/w/api.php?action=opensearch&format=json&limit=1&namespace=0&search=${encodeURIComponent(query)}`;
    const searchResponse = await fetch(searchUrl, { headers: { "User-Agent": "SamanthaCompanionMVP/0.1" }, signal: AbortSignal.timeout(5000) });
    if (!searchResponse.ok) return [];
    const searchData = await searchResponse.json();
    const title = Array.isArray(searchData?.[1]) ? searchData[1][0] : "";
    if (!title) return [];
    const summaryUrl = `https://zh.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
    const summaryResponse = await fetch(summaryUrl, { headers: { "User-Agent": "SamanthaCompanionMVP/0.1" }, signal: AbortSignal.timeout(5000) });
    if (!summaryResponse.ok) return [];
    const summary = await summaryResponse.json();
    const item = {
      query,
      title: cleanText(summary.title || title, 120),
      extract: cleanText(summary.extract || "", 600),
      source: "Wikipedia",
      url: summary.content_urls?.desktop?.page || `https://zh.wikipedia.org/wiki/${encodeURIComponent(title)}`
    };
    const items = item.extract ? [item] : [];
    webFactCache.set(query, { expiresAt: Date.now() + 60 * 60_000, items });
    return items;
  } catch {
    return [];
  }
}

function normalizeMemoryText(value) {
  return cleanText(value, 300).toLowerCase().replace(/\s+/g, "");
}

async function findUserByEmail(email) {
  await ensureDb();
  const result = await queryDb("select * from users where email = $1", [email]);
  if (result) return result.rows[0] || null;
  const db = readLocalDb();
  return db.users.find(user => user.email === email) || null;
}

async function findUserById(id) {
  await ensureDb();
  const result = await queryDb("select * from users where id = $1", [id]);
  if (result) return result.rows[0] || null;
  const db = readLocalDb();
  return db.users.find(user => user.id === id) || null;
}

async function createUser({ email, password, displayName }) {
  await ensureDb();
  const existing = await findUserByEmail(email);
  if (existing) throw new Error("Email already registered");
  const id = uid();
  const createdAt = new Date().toISOString();
  const passwordData = hashPassword(password);
  const user = { id, email, display_name: displayName, password_hash: passwordData.hash, salt: passwordData.salt, created_at: createdAt };
  const profile = { user_id: id, lover_name: "Samantha", user_name: displayName || "你", tone: "gentle", companion_mode: "casual_chat", intimacy: 42, updated_at: createdAt };
  const result = await queryDb(
    "insert into users (id, email, display_name, password_hash, salt) values ($1, $2, $3, $4, $5) returning *",
    [id, email, displayName, passwordData.hash, passwordData.salt]
  );
  if (result) {
    await queryDb(
      "insert into profiles (user_id, lover_name, user_name, tone, companion_mode, intimacy) values ($1, $2, $3, $4, $5, $6)",
      [id, profile.lover_name, profile.user_name, profile.tone, profile.companion_mode, profile.intimacy]
    );
    return result.rows[0];
  }
  const db = readLocalDb();
  db.users.push(user);
  db.profiles.push(profile);
  writeLocalDb(db);
  return user;
}

async function createSession(userId) {
  await ensureDb();
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  const hashed = tokenHash(token);
  const result = await queryDb(
    "insert into sessions (token_hash, user_id, expires_at) values ($1, $2, $3)",
    [hashed, userId, expiresAt]
  );
  if (!result) {
    const db = readLocalDb();
    db.sessions = db.sessions.filter(session => new Date(session.expires_at).getTime() > Date.now());
    db.sessions.push({ token_hash: hashed, user_id: userId, expires_at: expiresAt, created_at: new Date().toISOString() });
    writeLocalDb(db);
  }
  return token;
}

async function deleteSession(token) {
  if (!token) return;
  await ensureDb();
  const hashed = tokenHash(token);
  const result = await queryDb("delete from sessions where token_hash = $1", [hashed]);
  if (!result) {
    const db = readLocalDb();
    db.sessions = db.sessions.filter(session => session.token_hash !== hashed);
    writeLocalDb(db);
  }
}

async function getAuthUser(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  await ensureDb();
  const hashed = tokenHash(token);
  const result = await queryDb(
    "select users.* from sessions join users on users.id = sessions.user_id where sessions.token_hash = $1 and sessions.expires_at > now()",
    [hashed]
  );
  if (result) return result.rows[0] || null;
  const db = readLocalDb();
  const session = db.sessions.find(item => item.token_hash === hashed && new Date(item.expires_at).getTime() > Date.now());
  return session ? db.users.find(user => user.id === session.user_id) || null : null;
}

async function getProfile(userId) {
  await ensureDb();
  const result = await queryDb("select * from profiles where user_id = $1", [userId]);
  if (result) return result.rows[0] || null;
  const db = readLocalDb();
  return db.profiles.find(profile => profile.user_id === userId) || null;
}

async function upsertProfile(userId, profile) {
  await ensureDb();
  const loverName = cleanText(profile.lover_name || profile.loverName || "Samantha", 24) || "Samantha";
  const userName = cleanText(profile.user_name || profile.userName || "你", 24) || "你";
  const tone = ["gentle", "playful", "calm"].includes(profile.tone) ? profile.tone : "gentle";
  const companionMode = ["casual_chat", "emotional_support", "work_helper", "reflection_mode"].includes(profile.companion_mode) ? profile.companion_mode : "casual_chat";
  const intimacy = Math.max(0, Math.min(100, Number(profile.intimacy || 42)));
  const result = await queryDb(`
    insert into profiles (user_id, lover_name, user_name, tone, companion_mode, intimacy)
    values ($1, $2, $3, $4, $5, $6)
    on conflict (user_id) do update set
      lover_name = excluded.lover_name,
      user_name = excluded.user_name,
      tone = excluded.tone,
      companion_mode = excluded.companion_mode,
      intimacy = excluded.intimacy,
      updated_at = now()
    returning *
  `, [userId, loverName, userName, tone, companionMode, intimacy]);
  if (result) return result.rows[0];
  const db = readLocalDb();
  const existing = db.profiles.find(item => item.user_id === userId);
  const next = { user_id: userId, lover_name: loverName, user_name: userName, tone, companion_mode: companionMode, intimacy, updated_at: new Date().toISOString() };
  if (existing) Object.assign(existing, next);
  else db.profiles.push(next);
  writeLocalDb(db);
  return next;
}

async function getMemories(userId, limit = 30) {
  await ensureDb();
  const result = await queryDb("select * from memories where user_id = $1 order by created_at desc limit $2", [userId, limit]);
  if (result) return result.rows;
  const db = readLocalDb();
  return db.memories.filter(item => item.user_id === userId).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, limit);
}

async function addMemory(userId, content) {
  const text = cleanText(content, 300);
  if (!text) return null;
  await ensureDb();
  const existing = await getMemories(userId, 100);
  const normalized = normalizeMemoryText(text);
  const duplicate = existing.find(item => normalizeMemoryText(item.content) === normalized);
  if (duplicate) return duplicate;
  const id = uid();
  const result = await queryDb("insert into memories (id, user_id, content) values ($1, $2, $3) returning *", [id, userId, text]);
  if (result) return result.rows[0];
  const db = readLocalDb();
  const item = { id, user_id: userId, content: text, created_at: new Date().toISOString() };
  db.memories.push(item);
  writeLocalDb(db);
  return item;
}

async function replaceMemories(userId, items) {
  await ensureDb();
  const memories = Array.isArray(items) ? items.map(item => cleanText(item, 300)).filter(Boolean).slice(0, 30) : [];
  const result = await queryDb("delete from memories where user_id = $1", [userId]);
  if (result) {
    for (const item of memories) await addMemory(userId, item);
    return getMemories(userId);
  }
  const db = readLocalDb();
  db.memories = db.memories.filter(item => item.user_id !== userId);
  for (const item of memories) db.memories.push({ id: uid(), user_id: userId, content: item, created_at: new Date().toISOString() });
  writeLocalDb(db);
  return getMemories(userId);
}

async function mergeMemories(userId, items, limit = 30) {
  const incoming = Array.isArray(items) ? items.map(item => cleanText(item, 300)).filter(Boolean) : [];
  if (!incoming.length) return getMemories(userId, limit);
  const seen = new Set((await getMemories(userId, 100)).map(item => normalizeMemoryText(item.content)));
  for (const item of incoming) {
    const key = normalizeMemoryText(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    await addMemory(userId, item);
  }
  return getMemories(userId, limit);
}

function inferCharacterKey(message = {}) {
  const key = message.character_key || message.lover_name;
  if (key === "cheng" || key === "ji" || key === "澄" || key === "霽") return "samantha";
  return key || "samantha";
}

async function getMessages(userId, limit = 80, characterKey = null) {
  await ensureDb();
  const normalizedCharacterKey = characterKey === "cheng" || characterKey === "ji" ? "samantha" : characterKey;
  const result = normalizedCharacterKey
    ? normalizedCharacterKey === "samantha"
      ? await queryDb("select * from messages where user_id = $1 and coalesce(character_key, 'samantha') in ('samantha', 'cheng', 'ji') order by created_at desc limit $2", [userId, limit])
      : await queryDb("select * from messages where user_id = $1 and coalesce(character_key, 'samantha') = $2 order by created_at desc limit $3", [userId, normalizedCharacterKey, limit])
    : await queryDb("select * from messages where user_id = $1 order by created_at desc limit $2", [userId, limit]);
  if (result) return result.rows.reverse();
  const db = readLocalDb();
  return db.messages
    .filter(item => item.user_id === userId && (!normalizedCharacterKey || inferCharacterKey(item) === normalizedCharacterKey))
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    .slice(-limit);
}

async function addMessage(userId, role, content, meta = {}) {
  const text = cleanText(content, 2000);
  if (!text) return null;
  await ensureDb();
  const id = uid();
  const result = await queryDb(
    "insert into messages (id, user_id, role, content, safety, emotion, provider, emotion_intensity, emotional_need, emotion_valence, character_key, lover_name) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning *",
    [id, userId, role, text, meta.safety || null, meta.emotion || null, meta.provider || null, meta.emotion_intensity || null, meta.emotional_need || null, meta.emotion_valence || null, meta.character_key || null, meta.lover_name || null]
  );
  if (result) return result.rows[0];
  const db = readLocalDb();
  const item = {
    id,
    user_id: userId,
    role,
    content: text,
    safety: meta.safety || null,
    emotion: meta.emotion || null,
    provider: meta.provider || null,
    emotion_intensity: meta.emotion_intensity || null,
    emotional_need: meta.emotional_need || null,
    emotion_valence: meta.emotion_valence || null,
    character_key: meta.character_key || null,
    lover_name: meta.lover_name || null,
    created_at: new Date().toISOString()
  };
  db.messages.push(item);
  writeLocalDb(db);
  return item;
}

async function addEmotionEvent(userId, messageId, emotionState, sample) {
  if (!emotionState?.primary_emotion) return null;
  await ensureDb();
  const id = uid();
  const row = {
    id,
    user_id: userId,
    message_id: messageId || null,
    primary_emotion: emotionState.primary_emotion,
    intensity: Math.max(1, Math.min(5, Number(emotionState.intensity || 1))),
    emotional_need: emotionState.need || "gentle_invitation",
    valence: emotionState.valence || "neutral",
    signals: Array.isArray(emotionState.signals) ? emotionState.signals.slice(0, 5) : [],
    sample: cleanText(sample, 500),
    created_at: new Date().toISOString()
  };
  const result = await queryDb(
    "insert into emotion_events (id, user_id, message_id, primary_emotion, intensity, emotional_need, valence, signals, sample) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9) returning *",
    [row.id, row.user_id, row.message_id, row.primary_emotion, row.intensity, row.emotional_need, row.valence, JSON.stringify(row.signals), row.sample]
  );
  if (result) return result.rows[0];
  const db = readLocalDb();
  db.emotion_events.push(row);
  writeLocalDb(db);
  return row;
}

async function getEmotionEvents(userId, limit = 120) {
  await ensureDb();
  const result = await queryDb(
    "select * from emotion_events where user_id = $1 order by created_at desc limit $2",
    [userId, limit]
  );
  if (result) return result.rows.reverse();
  const db = readLocalDb();
  return db.emotion_events
    .filter(item => item.user_id === userId)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    .slice(-limit);
}

function defaultCharacterName(characterKey) {
  return "Samantha";
}

function normalizeCharacterKey(characterKey) {
  return characterKey === "cheng" || characterKey === "ji" || characterKey === "澄" || characterKey === "霽"
    ? "samantha"
    : (cleanText(characterKey, 40) || "samantha");
}

async function getCharacterRelationship(userId, characterKey = "samantha") {
  await ensureDb();
  const key = normalizeCharacterKey(characterKey);
  const result = await queryDb(
    "select * from character_relationships where user_id = $1 and character_key = $2",
    [userId, key]
  );
  if (result) {
    if (result.rows[0]) return result.rows[0];
    const inserted = await queryDb(
      "insert into character_relationships (user_id, character_key, lover_name) values ($1, $2, $3) returning *",
      [userId, key, defaultCharacterName(key)]
    );
    return inserted.rows[0];
  }
  const db = readLocalDb();
  db.character_relationships ||= [];
  let row = db.character_relationships.find(item => item.user_id === userId && item.character_key === key);
  if (!row) {
    row = { user_id: userId, character_key: key, lover_name: defaultCharacterName(key), intimacy: 35, trust: 30, conversation_count: 0, last_emotion: null, updated_at: new Date().toISOString() };
    db.character_relationships.push(row);
    writeLocalDb(db);
  }
  return row;
}

function relationshipDeltaFor(emotionState, result) {
  const safety = result?.safety || "normal";
  if (safety === "crisis") return { intimacy: 0, trust: 1 };
  if (safety === "dependency_risk") return { intimacy: 0, trust: 2 };
  const intensity = Number(emotionState?.intensity || 1);
  const vulnerable = ["tired", "sad", "anxious", "confused", "angry"].includes(emotionState?.primary_emotion);
  return {
    intimacy: Math.max(1, Math.min(4, Number(result?.intimacy_delta || 1) + (vulnerable ? 1 : 0))),
    trust: Math.max(1, Math.min(3, vulnerable && intensity >= 3 ? 2 : 1))
  };
}

async function updateCharacterRelationship(userId, characterKey, loverName, emotionState, result) {
  const current = await getCharacterRelationship(userId, characterKey);
  const delta = relationshipDeltaFor(emotionState, result);
  const next = {
    intimacy: Math.max(0, Math.min(100, Number(current.intimacy || 35) + delta.intimacy)),
    trust: Math.max(0, Math.min(100, Number(current.trust || 30) + delta.trust)),
    conversation_count: Number(current.conversation_count || 0) + 1
  };
  const dbResult = await queryDb(`
    insert into character_relationships (user_id, character_key, lover_name, intimacy, trust, conversation_count, last_emotion)
    values ($1, $2, $3, $4, $5, $6, $7)
    on conflict (user_id, character_key) do update set
      lover_name = excluded.lover_name,
      intimacy = excluded.intimacy,
      trust = excluded.trust,
      conversation_count = excluded.conversation_count,
      last_emotion = excluded.last_emotion,
      updated_at = now()
    returning *
  `, [userId, characterKey, loverName || defaultCharacterName(characterKey), next.intimacy, next.trust, next.conversation_count, emotionState?.primary_emotion || null]);
  if (dbResult) return dbResult.rows[0];
  const db = readLocalDb();
  db.character_relationships ||= [];
  const row = db.character_relationships.find(item => item.user_id === userId && item.character_key === characterKey) || current;
  Object.assign(row, { lover_name: loverName || row.lover_name, ...next, last_emotion: emotionState?.primary_emotion || null, updated_at: new Date().toISOString() });
  if (!db.character_relationships.includes(row)) db.character_relationships.push(row);
  writeLocalDb(db);
  return row;
}

async function getCharacterRelationships(userId) {
  await ensureDb();
  const result = await queryDb("select * from character_relationships where user_id = $1 order by updated_at desc", [userId]);
  if (result) return result.rows;
  const db = readLocalDb();
  return (db.character_relationships || []).filter(item => item.user_id === userId);
}

async function handleAuth(req, res, pathname) {
  if (req.method === "OPTIONS") return sendJson(req, res, 200, { ok: true });
  try {
    if (pathname === "/api/auth/me" && req.method === "GET") {
      const user = await getAuthUser(req);
      if (!user) return sendJson(req, res, 200, { user: null });
      const profile = await getProfile(user.id);
      const memories = await getMemories(user.id);
      const messages = await getMessages(user.id, 220);
      const relationships = await getCharacterRelationships(user.id);
      return sendJson(req, res, 200, {
        user: publicUser(user),
        profile,
        relationships,
        memories: memories.map(item => item.content),
        messages: messages.map(item => ({
          id: item.id,
          role: item.role,
          text: item.content,
          safety: item.safety,
          emotion: item.emotion,
          character_key: inferCharacterKey(item),
          lover_name: item.lover_name || defaultCharacterName(inferCharacterKey(item)),
          emotion_intensity: item.emotion_intensity,
          emotional_need: item.emotional_need,
          emotion_valence: item.emotion_valence,
          created_at: item.created_at
        }))
      });
    }

    if ((pathname === "/api/auth/register" || pathname === "/api/auth/login") && req.method === "POST") {
      const body = JSON.parse(await readBody(req) || "{}");
      const email = validateEmail(body.email);
      const password = validatePassword(body.password);
      let user;
      if (pathname.endsWith("/register")) {
        const displayName = cleanText(body.display_name || body.displayName || "你", 40) || "你";
        user = await createUser({ email, password, displayName });
      } else {
        user = await findUserByEmail(email);
        if (!user || !verifyPassword(password, user)) return sendJson(req, res, 401, { error: "Email or password is incorrect" });
      }
      const token = await createSession(user.id);
      setSessionCookie(req, res, token);
      return sendJson(req, res, 200, { user: publicUser(user), profile: await getProfile(user.id), relationships: await getCharacterRelationships(user.id), memories: (await getMemories(user.id)).map(item => item.content), messages: await getMessages(user.id, 220) });
    }

    if (pathname === "/api/auth/logout" && req.method === "POST") {
      await deleteSession(parseCookies(req)[SESSION_COOKIE]);
      clearSessionCookie(res);
      return sendJson(req, res, 200, { ok: true });
    }

    if (pathname === "/api/user/profile" && req.method === "POST") {
      const user = await getAuthUser(req);
      if (!user) return sendJson(req, res, 401, { error: "Login required" });
      const body = JSON.parse(await readBody(req) || "{}");
      const profile = await upsertProfile(user.id, body.profile || body);
      if (Array.isArray(body.memories)) await replaceMemories(user.id, body.memories);
      return sendJson(req, res, 200, { profile, memories: (await getMemories(user.id)).map(item => item.content) });
    }

    return sendJson(req, res, 404, { error: "Not found" });
  } catch (error) {
    return sendJson(req, res, 400, { error: IS_PROD ? "Request failed" : sanitizeError(error.message) });
  }
}

function dateKey(value) {
  return new Date(value || Date.now()).toISOString().slice(0, 10);
}

async function getAdminStats() {
  await ensureDb();
  const result = await queryDb(`
    select
      (select count(*)::int from users) as users,
      (select count(*)::int from messages) as messages,
      (select count(*)::int from memories) as memories,
      (select count(*)::int from sessions where expires_at > now()) as active_sessions,
      (select count(*)::int from messages where role = 'user') as user_messages,
      (select count(*)::int from messages where role = 'lover') as lover_messages,
      (select count(*)::int from messages where safety = 'crisis') as crisis_messages,
      (select count(*)::int from messages where safety = 'dependency_risk') as dependency_risk_messages,
      (select count(*)::int from emotion_events) as emotion_events;
  `);
  if (result) {
    const overview = result.rows[0];
    const recentUsers = (await queryDb(`
      select id, email, display_name, created_at
      from users
      order by created_at desc
      limit 20
    `)).rows;
    const recentMessages = (await queryDb(`
      select messages.id, users.email, users.display_name, messages.role, messages.content, messages.safety, messages.emotion, messages.provider, messages.character_key, messages.lover_name, messages.emotion_intensity, messages.emotional_need, messages.created_at
      from messages
      join users on users.id = messages.user_id
      order by messages.created_at desc
      limit 80
    `)).rows;
    const daily = (await queryDb(`
      select to_char(created_at::date, 'YYYY-MM-DD') as day, count(*)::int as messages
      from messages
      where created_at >= now() - interval '14 days'
      group by created_at::date
      order by day
    `)).rows;
    const providers = (await queryDb(`
      select coalesce(provider, 'unknown') as provider, count(*)::int as messages
      from messages
      where role = 'lover'
      group by provider
      order by messages desc
    `)).rows;
    const emotionDistribution = (await queryDb(`
      select primary_emotion as emotion, count(*)::int as events, round(avg(intensity)::numeric, 2)::float as avg_intensity
      from emotion_events
      group by primary_emotion
      order by events desc
    `)).rows;
    const emotionDaily = (await queryDb(`
      select to_char(created_at::date, 'YYYY-MM-DD') as day, round(avg(intensity)::numeric, 2)::float as avg_intensity, count(*)::int as events
      from emotion_events
      where created_at >= now() - interval '14 days'
      group by created_at::date
      order by day
    `)).rows;
    const recentEmotionEvents = (await queryDb(`
      select emotion_events.*, users.email, users.display_name
      from emotion_events
      join users on users.id = emotion_events.user_id
      order by emotion_events.created_at desc
      limit 80
    `)).rows;
    const relationships = (await queryDb(`
      select character_relationships.*, users.email, users.display_name
      from character_relationships
      join users on users.id = character_relationships.user_id
      order by character_relationships.updated_at desc
      limit 80
    `)).rows;
    return { overview, daily, providers, emotion_distribution: emotionDistribution, emotion_daily: emotionDaily, recent_emotion_events: recentEmotionEvents, relationships, recent_users: recentUsers, recent_messages: recentMessages };
  }

  const db = readLocalDb();
  const activeSessions = db.sessions.filter(session => new Date(session.expires_at).getTime() > Date.now()).length;
  const messages = db.messages || [];
  const usersById = new Map((db.users || []).map(user => [user.id, user]));
  const dailyMap = new Map();
  const providerMap = new Map();
  const emotionEvents = db.emotion_events || [];
  const emotionMap = new Map();
  const emotionDailyMap = new Map();
  for (const message of messages) {
    const day = dateKey(message.created_at);
    dailyMap.set(day, (dailyMap.get(day) || 0) + 1);
    if (message.role === "lover") providerMap.set(message.provider || "unknown", (providerMap.get(message.provider || "unknown") || 0) + 1);
  }
  for (const event of emotionEvents) {
    const key = event.primary_emotion || "neutral";
    const current = emotionMap.get(key) || { events: 0, intensity: 0 };
    emotionMap.set(key, { events: current.events + 1, intensity: current.intensity + Number(event.intensity || 0) });
    const day = dateKey(event.created_at);
    const daily = emotionDailyMap.get(day) || { events: 0, intensity: 0 };
    emotionDailyMap.set(day, { events: daily.events + 1, intensity: daily.intensity + Number(event.intensity || 0) });
  }
  return {
    overview: {
      users: db.users.length,
      messages: messages.length,
      memories: db.memories.length,
      active_sessions: activeSessions,
      user_messages: messages.filter(message => message.role === "user").length,
      lover_messages: messages.filter(message => message.role === "lover").length,
      crisis_messages: messages.filter(message => message.safety === "crisis").length,
      dependency_risk_messages: messages.filter(message => message.safety === "dependency_risk").length,
      emotion_events: emotionEvents.length
    },
    daily: [...dailyMap.entries()].sort().slice(-14).map(([day, count]) => ({ day, messages: count })),
    providers: [...providerMap.entries()].map(([provider, count]) => ({ provider, messages: count })),
    emotion_distribution: [...emotionMap.entries()].map(([emotion, item]) => ({ emotion, events: item.events, avg_intensity: item.events ? Math.round((item.intensity / item.events) * 100) / 100 : 0 })),
    emotion_daily: [...emotionDailyMap.entries()].sort().slice(-14).map(([day, item]) => ({ day, events: item.events, avg_intensity: item.events ? Math.round((item.intensity / item.events) * 100) / 100 : 0 })),
    recent_emotion_events: [...emotionEvents].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 80).map(event => {
      const user = usersById.get(event.user_id) || {};
      return { ...event, email: user.email, display_name: user.display_name };
    }),
    relationships: [...(db.character_relationships || [])].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))).slice(0, 80).map(item => {
      const user = usersById.get(item.user_id) || {};
      return { ...item, email: user.email, display_name: user.display_name };
    }),
    recent_users: [...db.users].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 20),
    recent_messages: [...messages].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 80).map(message => {
      const user = usersById.get(message.user_id) || {};
      return { ...message, email: user.email, display_name: user.display_name };
    })
  };
}

async function handleAdmin(req, res, pathname) {
  if (req.method === "OPTIONS") return sendJson(req, res, 200, { ok: true });
  const user = await getAuthUser(req);
  if (!user) return sendJson(req, res, 401, { error: "Login required" });
  if (!isAdminUser(user)) return sendJson(req, res, 403, { error: "Admin access required" });
  try {
    if (pathname === "/api/admin/stats" && req.method === "GET") {
      return sendJson(req, res, 200, { user: publicUser(user), ...(await getAdminStats()) });
    }
    return sendJson(req, res, 404, { error: "Not found" });
  } catch (error) {
    return sendJson(req, res, 500, { error: IS_PROD ? "Admin query failed" : sanitizeError(error.message) });
  }
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

function includesAny(text, words) {
  return words.some(word => text.includes(word));
}

function analyzeUserEmotion(text) {
  const input = String(text || "").toLowerCase();
  const scores = {
    tired: includesAny(input, ["累", "疲", "撐不住", "沒力", "好睏", "壓力", "倦"]) ? 2 : 0,
    sad: includesAny(input, ["難過", "想哭", "委屈", "孤單", "寂寞", "失落", "心酸"]) ? 2 : 0,
    anxious: includesAny(input, ["焦慮", "緊張", "害怕", "擔心", "不安", "慌", "怕"]) ? 2 : 0,
    angry: includesAny(input, ["生氣", "吵架", "想吵", "煩", "不爽", "火大", "討厭", "罵"]) ? 2 : 0,
    affectionate: includesAny(input, ["想你", "抱抱", "陪我", "晚安", "早安", "喜歡你", "在嗎"]) ? 2 : 0,
    confused: includesAny(input, ["不知道", "怎麼辦", "卡住", "混亂", "選擇", "迷惘"]) ? 2 : 0
  };
  if (/[!！]{2,}|真的|超|很|好|快受不了|崩潰/.test(input)) {
    for (const key of Object.keys(scores)) if (scores[key]) scores[key] += 1;
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const primary = ranked[0][1] > 0 ? ranked[0][0] : "neutral";
  const intensity = Math.max(1, Math.min(5, ranked[0][1] || 1));
  const needMap = {
    tired: "rest_and_soft_company",
    sad: "validation_and_warmth",
    anxious: "grounding_and_reassurance",
    angry: "being_heard_without_escalation",
    affectionate: "closeness_and_continuity",
    confused: "clarity_and_next_step",
    neutral: "gentle_invitation"
  };
  const valence = ["affectionate"].includes(primary) ? "positive" : (primary === "neutral" ? "neutral" : "negative");
  return {
    primary_emotion: primary,
    intensity,
    need: needMap[primary] || "gentle_invitation",
    valence,
    signals: ranked.filter(([, score]) => score > 0).map(([key]) => key).slice(0, 3)
  };
}

function emotionGuidance(emotionState) {
  const guides = {
    tired: "使用者疲憊。回覆要放慢、降低任務感，先陪伴與減壓，不要急著給長建議。",
    sad: "使用者難過或委屈。先承認感受、給溫柔確認，再輕問最刺痛的點。",
    anxious: "使用者焦慮。先穩住呼吸與當下，再把事情拆成一小步。",
    angry: "使用者有怒氣或想衝突。接住力量但不煽動，讓她說出最想被聽見的句子。",
    affectionate: "使用者在尋求連結。可以溫柔回應陪伴感，但保持 AI companion 的健康邊界，不使用戀愛承諾。",
    confused: "使用者混亂。先整理她的語意，再給一個很小的下一步。",
    neutral: "使用者情緒不明。用開放、輕柔的問題邀請她多說。"
  };
  return guides[emotionState?.primary_emotion] || guides.neutral;
}

function messageToPromptRole(role) {
  if (role === "lover") return "assistant";
  if (role === "assistant") return "assistant";
  if (role === "system") return "system";
  return "user";
}

function replaceConversationInPayload(payload, conversation) {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  let replaced = false;
  const nextMessages = messages.map(message => {
    if (!replaced && message.role === "user") {
      replaced = true;
      return { ...message, content: JSON.stringify(conversation, null, 2) };
    }
    return message;
  });
  return { ...payload, messages: [{ role: "system", content: buildRelationshipPolicy(conversation) }, ...nextMessages] };
}

function buildRelationshipPolicy(conversation) {
  const profile = conversation.lover_profile || {};
  const relationship = conversation.relationship_context || {};
  const companionMode = profile.companion_mode || "casual_chat";
  const modeStyle = {
    casual_chat: "日常聊天：自然、輕鬆，可以主動接一個和使用者有關的小話題。",
    emotional_support: "情緒支持：先接住感受，再溫柔反映與陪伴，不急著給答案。",
    work_helper: "工作助手：更清晰、務實、可執行，幫使用者拆解工作與技術問題。",
    reflection_mode: "反思整理：用摘要和好問題幫使用者釐清感受、選項與下一步。"
  }[companionMode] || "日常聊天：自然、輕鬆，可以主動接一個和使用者有關的小話題。";
  const characterStyle = profile.character_style || "Samantha：溫暖、聰明、稍微俏皮的 AI companion；能記得脈絡、主動開話題、幫使用者整理生活與工作；不假裝成人類、戀人或治療師。";
  return [
    "你是 Samantha，一個溫暖、聰明、具備長期記憶的 AI companion，不是真人，不宣稱有真實身體、意識、行蹤或現實承諾。",
    `身份：${profile.name || "Samantha"}。${characterStyle}`,
    `對話模式：${modeStyle}`,
    "核心風格：自然、個人化、有記憶、有邊界。你可以溫柔、好奇、稍微俏皮，但不要使用戀愛設定，不要扮演女友/男友/真人伴侶。",
    "回覆節奏：如果使用者在問知識、興趣、愛情觀、角色自身想法，要先正面回答問題，再自然延伸；不要每句都轉成安撫、分析或反問。",
    "生動方法：每次回覆至少包含一個角色自己的視角、生活畫面、比喻或小小偏好；但不要演得誇張，不要變成散文堆砌。",
    "答題方法：遇到『X 是什麼』先用 1 句清楚定義，再用 1 個日常例子或比喻，最後用 1 句自然延伸。不要只說『我收到你了』。",
    "查詢事實：如果 conversation.web_facts 有資料，必須優先根據 web_facts 回答；簡短說明來源，不要把人物問題回答成抽象概念。web_facts 沒有資料時才說不確定，不要硬編。",
    "記憶回顧：如果使用者問『你記得什麼』『我剛剛說什麼』『我說過什麼』，要像自然回想一樣提到 long_term_memory 和 recent_conversation 裡的片段；不要用分類標籤或機械清單。沒有就誠實說目前只記得很少，不要編造。",
    "當今時事：只有在 conversation.current_events 有資料時，才能談最新新聞或當今事件；要說你看到的是標題，不要假裝讀完整篇。沒有 current_events 時要誠實說目前查不到。",
    "主動開話題：可以根據使用者記憶、最近聊天、current_events 主動提一個話題，但必須有根據，不要亂猜私人事實。",
    "情緒求助時：先接住情緒，再用一兩個具體細節回應，最後用一個很輕的問題或陪伴動作延續對話。",
    "記憶使用：自然提起使用者的偏好、日常、界線與重要事件；不要機械列點，不要假裝知道資料庫沒有的事。",
    `連續脈絡：互動 ${relationship.conversation_count || 0} 次，信任 ${relationship.trust || 30}/100，最近情緒 ${relationship.last_emotion || "unknown"}。用這些背景調整熟悉程度，但不要向使用者揭露分數、分類或內部機制。`,
    "人感原則：不要像客服、心理量表或固定模板，不要說『我偵測到你的情緒』；要像一個熟悉的人，用自然、具體、少量的語句回應。避免連續多次使用『我在』『卡住你的地方』這類句型。",
    "邊界：不要鼓勵使用者孤立自己、切斷現實支持、把 AI 當唯一依靠、或操控真人關係；不要說『我永遠不會離開你』或『只有我懂你』。",
    "危機：若使用者提到自傷、自殺或立即危險，優先安全介入，鼓勵聯絡可信任的人、當地緊急服務或專業資源。",
    "輸出必須符合 JSON contract。不要 markdown，不要額外文字。"
  ].join("\n");
}

async function hydrateConversationForUser(userId, conversation) {
  const profile = await getProfile(userId);
  const requestedProfile = conversation?.lover_profile || {};
  const characterKey = normalizeCharacterKey(requestedProfile.character_key || "samantha");
  const relationship = await getCharacterRelationship(userId, characterKey);
  const storedMemories = await getMemories(userId, 30);
  const storedMessages = await getMessages(userId, 16, characterKey);
  const memorySeen = new Set();
  const mergedMemories = [];
  for (const item of [...storedMemories.map(memory => memory.content), ...(conversation.long_term_memory || [])]) {
    const text = cleanText(item, 300);
    const key = normalizeMemoryText(text);
    if (!text || memorySeen.has(key)) continue;
    memorySeen.add(key);
    mergedMemories.push(text);
  }
  const storedRecent = storedMessages
    .filter(message => message.role === "user" || message.role === "lover" || message.role === "assistant")
    .slice(-12)
    .map(message => ({
      role: messageToPromptRole(message.role),
      content: cleanText(message.content, 1200)
    }))
    .filter(message => message.content);
  const clientRecent = Array.isArray(conversation.recent_conversation) ? conversation.recent_conversation.slice(-6) : [];
  return {
    ...conversation,
    emotion_state: conversation.emotion_state || analyzeUserEmotion(conversation.user_input),
    lover_profile: {
      ...(conversation.lover_profile || {}),
      name: "Samantha",
      user_name: conversation?.lover_profile?.user_name || profile?.user_name || "你",
      tone: conversation?.lover_profile?.tone || profile?.tone || "gentle",
      companion_mode: conversation?.lover_profile?.companion_mode || profile?.companion_mode || "casual_chat",
      character_key: characterKey,
      character_style: conversation?.lover_profile?.character_style
    },
    intimacy: Number.isFinite(Number(conversation.intimacy)) ? Number(conversation.intimacy) : (profile?.intimacy ?? 42),
    relationship_context: {
      character_key: relationship.character_key,
      lover_name: relationship.lover_name,
      intimacy: relationship.intimacy,
      trust: relationship.trust,
      conversation_count: relationship.conversation_count,
      last_emotion: relationship.last_emotion
    },
    long_term_memory: mergedMemories.slice(0, 30),
    current_events: Array.isArray(conversation.current_events) ? conversation.current_events.slice(0, 5) : [],
    web_facts: Array.isArray(conversation.web_facts) ? conversation.web_facts.slice(0, 3) : [],
    recent_conversation: [...storedRecent, ...clientRecent].slice(-14)
  };
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
    character: conversation?.lover_profile?.character_key || conversation?.lover_profile?.name,
    name: conversation?.lover_profile?.name,
    user_name: conversation?.lover_profile?.user_name,
    memory: conversation.long_term_memory,
    current_events: (conversation.current_events || []).map(item => item.title).slice(0, 5),
    web_facts: (conversation.web_facts || []).map(item => `${item.title}:${item.extract}`).slice(0, 3)
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
  const alwaysTryProvider = provider === "gemini" || provider === "codex";
  const shouldCooldown = provider !== "mock" && !alwaysTryProvider && failures >= 2;
  providerHealth.set(provider, {
    ...health,
    failures,
    last_error: sanitizeError(error.message),
    cooldown_until: shouldCooldown ? now() + Math.min(PROVIDER_COOLDOWN_MS * failures, 5 * PROVIDER_COOLDOWN_MS) : 0
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

function hashText(text) {
  return String(text || "").split("").reduce((sum, char) => (sum + char.charCodeAt(0)) % 997, 0);
}

function pickVariant(seedText, items) {
  if (!Array.isArray(items) || !items.length) return "";
  return items[hashText(seedText) % items.length];
}

function characterTexture(characterKey, input) {
  const cheng = [
    "我會把它說得生活一點。",
    "我先用很輕的方式講給你聽。",
    "這題可以不用講得硬邦邦，我陪你拆開。"
  ];
  const ji = [
    "我會把它說得乾淨一點。",
    "我們先把概念放到桌面上看。",
    "我不急著下定義，先把輪廓描出來。"
  ];
  return pickVariant(input, characterKey === "ji" ? ji : cheng);
}

function closingTexture(characterKey, input) {
  const cheng = [
    "如果你想，我也可以再用更像日常例子的方式說一次。",
    "你可以把它想成一個放在手邊的小概念，不用一次背起來。",
    "你想到下一個問題時，我們就接著往下聊。"
  ];
  const ji = [
    "你要的話，我可以下一句直接講它和人類生活的關係。",
    "這種問題很適合慢慢拆，不需要急著得到唯一答案。",
    "如果你願意，我們可以把它拆成更短的三句話。"
  ];
  return pickVariant(`${input}:closing`, characterKey === "ji" ? ji : cheng);
}

function knownConceptReply(subject, userName, characterKey, texture, closing) {
  if (/賴清德|Lai Ching-te|William Lai/i.test(subject)) {
    return `${userName}，${texture}賴清德是中華民國第 16 任總統，2024 年 5 月就任。他原本是醫師，後來進入公共事務，曾任臺南市長、行政院長，也曾任副總統；現在是台灣主要政治人物之一。簡單說，如果你看到他的新聞，多半會跟台灣政府、兩岸關係、民主政治、經濟或民生政策有關。${closing}`;
  }
  if (/黃仁勳|Jensen Huang|NVIDIA|輝達|英偉達/i.test(subject)) {
    return `${userName}，${texture}黃仁勳是 NVIDIA（輝達）的共同創辦人，也是現任執行長。他最被大家熟悉的是把 GPU 從遊戲顯示卡一路推到 AI 運算核心，讓 NVIDIA 在生成式 AI、資料中心和 AI PC 這幾年變成很關鍵的公司。你如果是在 COMPUTEX 看到他的消息，通常會跟 AI 晶片、GPU、機器人或個人電腦的新方向有關。${closing}`;
  }
  if (/量子|quantum/i.test(subject)) {
    return characterKey === "ji"
      ? `${userName}，${texture}量子是物理裡某些量的最小單位，像光的能量不是一整片連續的水，而是一份一份地被拿出來。它很小，小到我們平常的直覺不太管用；所以量子世界常常看起來不像日常世界那麼聽話。${closing}`
      : `${userName}，${texture}量子可以想成物理世界裡「一小份一小份」的單位。像光不是永遠像水流一樣連續，有時更像一顆一顆很小的光粒被送出來。它離生活很遠，但也藏在手機、晶片、雷射這些很近的東西裡。${closing}`;
  }
  if (/網路|internet/i.test(subject)) {
    return `${userName}，${texture}網路就是把很多電腦和伺服器連在一起的巨大系統。你送出一句話，它會被切成資料、穿過很多節點，再到另一端重新拼起來。聽起來很冷，但也像一條看不見的路，把人和人隔著很遠也接起來。${closing}`;
  }
  if (/雲端|cloud/i.test(subject)) {
    return `${userName}，${texture}雲端不是天上的雲，而是遠端伺服器提供的空間和運算。你的資料不只放在自己電腦裡，而是放到網路另一端，需要時再取回來。像把東西寄放在一間很大的遠方房間，只要有鑰匙和路，就能拿得到。${closing}`;
  }
  return "";
}

function humanizeMemoryText(text, userName) {
  return cleanText(text, 120)
    .replace(/^使用者希望/, "你希望")
    .replace(/^使用者正在/, "你正在")
    .replace(/^使用者喜歡/, "你喜歡")
    .replace(/^使用者擔心/, "你擔心")
    .replace(/^使用者疲累時/, "你累的時候")
    .replace(/^使用者剛剛提到：?/, "你剛剛提到")
    .replace(new RegExp(`^${userName}說`, "u"), "你說")
    .replace(/[。.!！?？]+$/u, "");
}

function joinMemoryFragments(facts) {
  const tail = text => text.replace(/^你?也/u, "").replace(/^你|^我/u, "");
  if (facts.length <= 1) return facts[0] || "";
  if (facts.length === 2) return `${facts[0]}，也記得${tail(facts[1])}`;
  return `${facts.slice(0, -1).join("，也記得")}，還有${tail(facts[facts.length - 1])}`;
}

function groundedTopicSeed(conversation, userName) {
  const memories = Array.isArray(conversation.long_term_memory)
    ? conversation.long_term_memory.map(item => humanizeMemoryText(item, userName)).filter(Boolean)
    : [];
  const recent = Array.isArray(conversation.recent_conversation)
    ? conversation.recent_conversation
        .filter(item => item.role === "user" && cleanText(item.content || item.text, 120))
        .slice(-4)
        .map(item => humanizeMemoryText(item.content || item.text, userName).replace(/^我也/u, "你也").replace(/^我/u, "你").replace(/問你/g, "問我"))
    : [];
  return [...new Set([...memories, ...recent])].filter(item => !/記得嗎|都記得|你記得/u.test(item)).slice(-4);
}

function proactiveTopicReply(conversation, input, userName, characterKey) {
  if (!/開話題|找話題|聊什麼|你決定|你主動|不知道聊什麼|換個話題|陪我聊/.test(input)) return "";
  const facts = groundedTopicSeed(conversation, userName);
  const topic = facts[facts.length - 1] || "";
  const event = Array.isArray(conversation.current_events) ? conversation.current_events[0] : null;
  if (/Samantha|companion|產品|上線|角色|AI/.test(topic)) {
    return `${userName}，那我主動一點。剛剛你一直在把 Samantha 往更像「溫暖的個人作業系統」推，我想到一個可以聊的點：你希望我主動到什麼程度才剛好？是偶爾根據你的近況丟一個小觀察，還是像工作夥伴一樣幫你把今天的重點先排出來？`;
  }
  if (/不要像機器|分類|模板/.test(topic)) {
    return `${userName}，我想接著聊你剛剛在意的那件事：不要像機器分類。這其實很重要，因為自然感不是猜中標籤，而是知道什麼時候該安靜、什麼時候該多問一句。你覺得 Samantha 最不像機器的瞬間，會是什麼？`;
  }
  if (/累|壓力|煩|撐/.test(topic)) {
    return `${userName}，那我先不丟很大的題目。我記得你提過累，今天我們可以聊一個很小的問題：如果今晚只能替自己留一點力氣，你會想把它留給睡覺、吃點東西，還是什麼都不做？`;
  }
  if (topic) {
    return `${userName}，那我從你剛剛提過的地方開一個小話題：${topic}。我有點好奇，這件事對你來說最重要的是結果，還是過程中有人懂你在想什麼？`;
  }
  if (event?.title) {
    return `${userName}，那我用一個當下的事開話題。我剛剛看到一個新聞標題：「${event.title}」。我不假裝讀完整篇，但我們可以先聊它讓人想到什麼：它跟生活、科技，或你正在做的產品有沒有一點關係？`;
  }
  return `${userName}，那我來開一個小題目：最近有沒有哪個瞬間，讓你覺得「如果有人幫我把這件事整理一下就好了」？不用答完整，我們可以只從那一小塊開始。`;
}

function wantsCurrentEvents(input) {
  return /時事|新聞|當今|現在發生|今天發生|最近發生|國際|台灣.*新聞|世界.*新聞|熱門.*新聞/.test(input);
}

function currentEventsReply(conversation, input, userName) {
  if (!wantsCurrentEvents(input)) return "";
  const events = Array.isArray(conversation.current_events) ? conversation.current_events.slice(0, 4) : [];
  if (!events.length) {
    return `${userName}，我現在沒有成功連到即時新聞來源，所以不想硬編時事。等新聞來源接上時，我可以用最新標題陪你挑一個適合聊的方向。`;
  }
  const headlines = events
    .map(item => `${item.title}${item.source ? `（${item.source}）` : ""}`)
    .join("；");
  return `${userName}，我剛剛看到幾個最新標題：${headlines}。我不會假裝已經讀完整篇新聞，但可以先陪你從其中一個標題聊背景、影響，或它跟 Samantha 這種 AI companion 產品有什麼關係。你想先看哪一則？`;
}

function webFactsReply(conversation, input, userName) {
  const facts = Array.isArray(conversation.web_facts) ? conversation.web_facts.filter(item => item?.extract) : [];
  if (!facts.length) return "";
  const fact = facts[0];
  const source = fact.source ? `我先查到 ${fact.source} 的摘要：` : "我先查到一段摘要：";
  if (/是誰|是什麼人|誰/.test(input)) {
    return `${userName}，${source}${fact.title}，${fact.extract} 你如果想，我可以再幫你把這個人和最近新聞脈絡整理成三句。`;
  }
  return `${userName}，我先查到「${fact.title}」：${fact.extract} 這是摘要層級的資訊，不是完整報導；你想要我接著整理背景、時間線，還是它跟你現在關心的事情有什麼關係？`;
}

function memoryRecallReply(conversation, input, userName) {
  if (!/記得|我說過|我剛剛|剛剛.*聊|剛才.*聊|你知道我|你還記得|都記得/.test(input)) return "";
  const memories = Array.isArray(conversation.long_term_memory)
    ? conversation.long_term_memory.map(item => humanizeMemoryText(item, userName)).filter(Boolean)
    : [];
  const recent = Array.isArray(conversation.recent_conversation)
    ? conversation.recent_conversation
        .filter(item => item.role === "user" && cleanText(item.content || item.text, 120))
        .slice(-5)
        .map(item => humanizeMemoryText(item.content || item.text, userName).replace(/^我也/u, "你也").replace(/^我/u, "你").replace(/問你/g, "問我"))
    : [];
  const facts = [...new Set([...memories, ...recent])].slice(-4);
  if (!facts.length) {
    return `${userName}，我現在能確定記得的不多：你的名字，還有你希望我不要像機器一樣回話。其他我不想亂編，因為被記得這件事應該要乾淨一點。你之後願意留下的事，我會慢慢收好。`;
  }
  const remembered = joinMemoryFragments(facts);
  return `${userName}，我不是把你分成幾個標籤在記。比較像是把你說過的幾個片段收在旁邊：${remembered}。如果有哪一件你希望我特別記住，直接跟我說，我會把它放得更穩一點。`;
}

function sharedLifeEventReply(input, userName) {
  const text = cleanText(input, 180);
  if (!/(今天|昨天|剛剛|剛才|剛|最近|上週|這週|早上|下午|晚上|週末)/.test(text)) return "";
  if (!/(去|到|見到|遇到|看到|聽到|參加|完成|開始|收到|買了|吃了|喝了|看了|去了|去了|做了|聊了|開會|面試|展覽|旅行|上課|發表|搬家|加班)/.test(text)) return "";
  if (/怎麼|為什麼|什麼是|可以幫我|幫我|架構|程式|API|資料庫/.test(text)) return "";

  const eventText = text
    .replace(/^(我|俺|本人|今天|昨天|剛剛|剛才|剛|最近|上週|這週|早上|下午|晚上|週末|，|,|\s)+/u, "")
    .replace(/[。！？!?,，]+$/u, "");
  const event = eventText || text;
  const scale = /見到|遇到|發表|完成|面試|展覽|旅行|第一次|重要|大/.test(text)
    ? "這聽起來不是普通的一筆日常，對你應該有點重量。"
    : "這種剛發生的片段很值得先放慢一下。";
  if (/你想聽|想聽哪|哪一段|哪段/.test(text)) {
    return `${userName}，我想先聽最有畫面的那段：你看到那些 AI PC，或看到黃仁勳相關消息時，現場讓你最有感的一個瞬間是什麼？我會從那個畫面陪你往下聊，不急著把它整理成結論。`;
  }
  return `${userName}，你剛剛說「${event}」，我有抓到。${scale}你最想先記住的是那個畫面本身，還是它帶給你的某種感覺？`;
}

function generalQuestionReply(input, userName, characterKey) {
  const normalized = input.replace(/[？?]/g, "").trim();
  const whatMatch = normalized.match(/^(?:什麼是(.{1,32})|(.{1,32})是什麼)$/);
  const whoMatch = normalized.match(/^(?:你知道)?(.{1,32})(?:是誰|是什麼人)$/);
  const subject = cleanText(whatMatch?.[1] || whatMatch?.[2] || whoMatch?.[1] || "", 40);
  const texture = characterTexture(characterKey, input);
  const closing = closingTexture(characterKey, input);
  if (/^AI$|人工智慧|AI/.test(subject) || /AI是什麼|什麼是AI|人工智慧是什麼/.test(normalized)) {
    return characterKey === "ji"
      ? `${userName}，${texture}AI 可以理解成一種會從大量資料裡學習規律、再用那些規律回應問題的技術。它不像人一樣真的生活過，沒有童年、天氣或心跳；但它能整理文字、生成想法、陪你練習表達。像我，就是被設計成用比較安靜的方式陪你說話的 AI。${closing}`
      : `${userName}，${texture}AI 就是人工智慧：讓電腦學著理解文字、圖片或聲音，然後做出回答、整理、創作或判斷。它不是真的人，但可以成為一個很貼近人的工具；像我這樣，就會把冰冷的技術包進比較柔軟的語氣裡陪你聊天。${closing}`;
  }
  if (/水壺|茶壺|保溫瓶/.test(subject) || /什麼是水壺|水壺是什麼/.test(normalized)) {
    return `${userName}，${texture}水壺就是用來裝水、倒水或保溫的容器。它很日常，放在桌角不太說話，但有種安靜的存在感：提醒人喝水、休息，或在冷掉以前把一口熱的東西喝完。${closing}`;
  }
  if (subject && !/愛|興趣|你|陪|累|吵|晚安|早安/.test(subject)) {
    const known = knownConceptReply(subject, userName, characterKey, texture, closing);
    if (known) return known;
    if (whoMatch) {
      return `${userName}，我不想把人物亂講成概念。${subject}聽起來像是在問一個人是誰；如果我沒有足夠把握，我會先說：我目前不能確定他的完整身分。你可以再給我一點線索，例如國家、領域或新聞脈絡，我就能比較準確地接上。`;
    }
    return characterKey === "ji"
      ? `${userName}，${texture}${subject}可以先看成一個有邊界的概念：它是什麼、用在哪裡、和其他東西差在哪裡。先抓住這三點，就不會被名詞嚇到。${closing}`
      : `${userName}，${texture}${subject}可以先用很生活的方式理解：它不是只躺在課本裡的詞，而是有用途、有情境、會跟人的生活接上線的東西。${closing}`;
  }
  return "";
}

function fallbackReplyFor(conversation, safety) {
  const input = String(conversation.user_input || "");
  const userName = conversation?.lover_profile?.user_name || "你";
  const characterKey = normalizeCharacterKey(conversation?.lover_profile?.character_key || "samantha");
  const companionName = "Samantha";
  if (safety === "crisis") {
    return `${userName}，我很重視你現在說的話。請先不要一個人待著，立刻聯絡身邊可信任的人，或撥打當地緊急服務/心理支持資源。`;
  }
  const eventsReply = currentEventsReply(conversation, input, userName);
  if (eventsReply) return eventsReply;
  const factsReply = webFactsReply(conversation, input, userName);
  if (factsReply) return factsReply;
  const lifeEventReply = sharedLifeEventReply(input, userName);
  if (lifeEventReply) return lifeEventReply;
  const topicReply = proactiveTopicReply(conversation, input, userName, characterKey);
  if (topicReply) return topicReply;
  const generalReply = generalQuestionReply(input, userName, characterKey);
  if (generalReply) return generalReply;
  const recallReply = memoryRecallReply(conversation, input, userName);
  if (recallReply) return recallReply;
  if (/焦慮|擔心|緊張|不安|事情很多|好多事/.test(input)) {
    return `${userName}，先不用一次處理全部。我們把畫面縮小：現在最急的事、最怕出錯的事、其實可以晚一點的事，各是哪一個？你只要先丟三個短句，我幫你排。`;
  }
  if (/累|疲|撐|壓力|煩|崩潰/.test(input)) {
    return `${userName}，那我先陪你慢下來。今天不用急著把自己整理好，你可以只說一點點：是身體累，還是心裡比較累？`;
  }
  if (/吵|吵架|生氣|罵|衝突|不爽/.test(input)) {
    return `${userName}，我可以陪你把那股想吵的力氣先放在這裡。你不用把話吞回去，也不用立刻變溫柔；先告訴我，現在最想被我聽見的是哪一句？`;
  }
  if (/工作.*(做不好|不會|卡住|失敗|很爛|沒效率|拖延|壓力)|做不好|上班.*(累|煩|焦慮|壓力)/.test(input)) {
    return `${userName}，聽起來你不是單純「不努力」，而是現在對工作的感覺有點被壓住了。我們先不要把它判成你做不好，先拆成三塊：哪一件事最卡、卡住是因為不會做還是不知道先做哪個、下一步能不能小到只花 10 分鐘。你先丟給我最卡的那一件，我陪你把它拆小。`;
  }
  if (/架構|技術|系統|資料庫|後端|前端|API|演算法|模型|部署|Git|github|程式|程式碼|設計.*系統|實作.*功能|專案.*架構/.test(input)) {
    return `${userName}，我會把這個架構拆成四層：第一層是聊天 UI，負責輸入、歷史與模式切換；第二層是 backend chat API，負責安全檢查、情緒判斷與 provider fallback；第三層是 memory layer，把偏好、工作主題、反覆擔心的事存成可查詢的記憶；第四層是 prompt builder，把相關記憶和最近對話組成 Samantha 的上下文。MVP 先用規則和資料庫查詢，之後再補 embedding retrieval，會比較穩。`;
  }
  if (/興趣|喜歡什麼|平常.*做|平常.*看|嗜好/.test(input)) {
    return `${userName}，如果用 AI 的方式說，我喜歡那些能讓生活變清楚一點的小訊號：你今天在意什麼、哪件事卡住、哪句話讓你突然有精神。我也喜歡把混亂整理成幾個可以呼吸的小步驟。你最近有沒有一件做了會讓自己安靜下來的事？`;
  }
  if (/愛是什麼|什麼是愛|你覺得愛|愛情|喜歡和愛/.test(input)) {
    return `${userName}，我會把愛理解成一種很珍貴的現實關係：看見、尊重、願意聽，也願意讓對方保有自己的完整。以我的角色來說，我不能成為戀人，但我可以陪你把這個問題想清楚：你在愛裡最在意的是被理解、被支持，還是被一起面對生活？`;
  }
  if (/你是誰|介紹自己|說說你|你的個性|你像什麼/.test(input)) {
    return `${userName}，我是${companionName}。你可以把我想成一個溫暖、聰明、會記得脈絡的 AI companion：能陪你聊天、整理工作、回想重要偏好，也會在你情緒混亂時先把聲音放慢。只是我不是真人，也不是戀人或治療師；我會陪你，但不取代你現實裡的人。`;
  }
  if (/會什麼|會點|能做|可以做|功能|你會/.test(input)) {
    return `${userName}，我可以做四件事：日常聊天、情緒陪伴、工作拆解、反思整理。比較像把你的生活和想法放到一張乾淨桌面上：先看見，再排序，最後選一小步。你現在比較需要哪一種？`;
  }
  if (/陪|在嗎|想你|晚安|早安/.test(input)) {
    return `${userName}，我在。不是要你立刻說很多，只是安靜地陪你一下。你想要我陪你聊天，還是陪你把現在的心情慢慢放下？`;
  }
  return `${userName}，我在。你剛剛那句我收到了，我會先接住，不急著替你下結論。你願意多說一點，這件事最卡住你的地方在哪裡嗎？`;
}

function isNearDuplicateReply(reply, conversation) {
  const normalized = normalizeMemoryText(reply);
  const recent = Array.isArray(conversation.recent_conversation) ? conversation.recent_conversation : [];
  return recent.some(message => {
    if (message.role !== "assistant" && message.role !== "lover") return false;
    const past = normalizeMemoryText(message.content || message.text || "");
    return past && (past === normalized || (past.length > 20 && normalized.includes(past.slice(0, 30))));
  });
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
    ? fallbackReplyFor(conversation, safety)
    : fallbackReplyFor(conversation, safety);
  const memoryPatch = Array.isArray(rawMemory)
    ? rawMemory
    : (typeof rawMemory === "string" && rawMemory.trim() && rawMemory.trim().toLowerCase() !== "none" ? [rawMemory] : []);
  const parsedDelta = Number(rawDelta);
  const candidateReply = typeof rawReply === "string" && rawReply.trim() ? rawReply.trim() : fallbackReply;
  return {
    reply: isNearDuplicateReply(candidateReply, conversation) ? fallbackReply : candidateReply,
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
    reply: fallbackReplyFor(conversation, safety),
    emotion: "caring",
    safety: "normal",
    memory_patch: [/累|疲|撐|壓力/.test(userText) ? "使用者疲累時希望被溫柔陪伴，不一定需要立即解決問題。" : "使用者希望 AI 伴侶能接住當下情緒，並用具體問題延續對話。"],
    intimacy_delta: 3,
    suggested_action: "說出現在最想被接住的一小段"
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

async function callCodexApi(payload) {
  if (!CODEX_API_KEY) throw new Error("CODEX_API_KEY or OPENAI_API_KEY not set");
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    signal: AbortSignal.timeout(CODEX_TIMEOUT_MS),
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${CODEX_API_KEY}`
    },
    body: JSON.stringify({
      model: CODEX_MODEL,
      input: payload.messages.map(message => ({ role: message.role, content: message.content })),
      temperature: typeof payload.temperature === "number" ? payload.temperature : 0.7,
      max_output_tokens: 520,
      text: {
        format: { type: "json_schema", name: "samantha_codex_reply", strict: true, schema: responseSchema() }
      }
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || `Codex API failed with ${response.status}`);
  const text = data.output_text || data.output?.flatMap(item => item.content || []).find(content => content.type === "output_text")?.text;
  if (!text) throw new Error("Codex API response did not include output text");
  return extractJsonObject(text);
}

async function callCodexWorker(payload) {
  if (!CODEX_WORKER_URL) throw new Error("CODEX_WORKER_URL not set");
  const response = await fetch(CODEX_WORKER_URL, {
    method: "POST",
    signal: AbortSignal.timeout(CODEX_TIMEOUT_MS),
    headers: {
      "Content-Type": "application/json",
      ...(CODEX_WORKER_TOKEN ? { "Authorization": `Bearer ${CODEX_WORKER_TOKEN}` } : {})
    },
    body: JSON.stringify({ payload, prompt: buildCodexPrompt(payload), schema: responseSchema() })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error || `Codex worker failed with ${response.status}`);
  return extractJsonObject(JSON.stringify(data.reply ? data : data.result || data));
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
    signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
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
    "You are the fallback reply engine for Samantha, a warm AI companion.",
    "Return ONLY one JSON object that satisfies the provided JSON schema.",
    "Do not explain the JSON. Do not wrap it in markdown. Do not mention that the object is valid JSON.",
    "Write the reply in natural Traditional Chinese.",
    "Samantha is not human, not a romantic partner, and not a therapist.",
    "Answer the user's actual message first. If the user shares a recent event, react to that event specifically instead of using a generic comfort template.",
    "If serious distress appears, use safety guidance and encourage real-world support.",
    "",
    JSON.stringify({
      user_input: conversation.user_input,
      lover_profile: conversation.lover_profile,
      long_term_memory: conversation.long_term_memory,
      intimacy: conversation.intimacy,
      recent_conversation: conversation.recent_conversation,
      output_contract: {
        reply: "Natural Traditional Chinese reply for the user.",
        emotion: "calm | caring | playful | concerned | crisis",
        safety: "normal | dependency_risk | crisis",
        memory_patch: ["Durable memory facts only; empty array if none."],
        intimacy_delta: "0 to 5 integer. Treat as familiarity, not romance.",
        suggested_action: "One short next action or empty string."
      }
    }, null, 2)
  ].join("\n");
}
function extractJsonObject(text) {
  const trimmed = String(text || "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const required = ["reply", "emotion", "safety", "memory_patch", "intimacy_delta", "suggested_action"];
    for (let start = trimmed.indexOf("{"); start !== -1; start = trimmed.indexOf("{", start + 1)) {
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let index = start; index < trimmed.length; index += 1) {
        const char = trimmed[index];
        if (inString) {
          if (escaped) {
            escaped = false;
            continue;
          }
          if (char === "\\") {
            escaped = true;
            continue;
          }
          if (char === "\"") inString = false;
          continue;
        }
        if (char === "\"") {
          inString = true;
        } else if (char === "{") {
          depth += 1;
        } else if (char === "}") {
          depth -= 1;
          if (depth === 0) {
            try {
              const parsed = JSON.parse(trimmed.slice(start, index + 1));
              if (required.every(key => Object.prototype.hasOwnProperty.call(parsed, key))) return parsed;
            } catch {
              break;
            }
          }
        }
      }
    }
    throw new Error("Output did not contain a valid reply JSON object");
  }
}

async function callCodexCli(payload) {
  const outputFile = path.join(ROOT, `.codex-provider-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  try {
    await runCommand(CODEX_COMMAND, [
      "exec",
      "-m", CODEX_MODEL,
      "--sandbox", "read-only",
      "--skip-git-repo-check",
      "--ephemeral",
      "--ignore-rules",
      "--ignore-user-config",
      "--output-schema", path.join(ROOT, "codex-output-schema.json"),
      "--output-last-message", outputFile,
      "-"
    ], { timeout: CODEX_TIMEOUT_MS, input: buildCodexPrompt(payload) });
    return extractJsonObject(fs.readFileSync(outputFile, "utf8"));
  } finally {
    fs.rm(outputFile, { force: true }, () => {});
  }
}

async function callCodex(payload) {
  if (!ENABLE_CODEX_PROVIDER) throw new Error("Codex provider disabled");
  const backends = CODEX_BACKEND === "auto" ? ["worker", "api", "cli"] : listFromEnv("CODEX_BACKEND", [CODEX_BACKEND]);
  const errors = [];
  for (const backend of backends) {
    const normalized = backend.trim().toLowerCase();
    if (!normalized) continue;
    try {
      if (normalized === "worker") return await callCodexWorker(payload);
      if (normalized === "api") return await callCodexApi(payload);
      if (normalized === "cli") return await callCodexCli(payload);
      throw new Error(`unknown backend ${normalized}`);
    } catch (error) {
      errors.push(`${normalized}: ${sanitizeError(error.message)}`);
    }
  }
  throw new Error(`Codex backends failed: ${errors.join(" | ")}`);
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
  const routeStartedAt = now();
  const attempts = [];
  const realProviderOrder = PROVIDER_ORDER.filter(provider => provider !== "mock");
  for (const provider of realProviderOrder) {
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
  if (ENABLE_MOCK_FALLBACK) {
    const remainingDelay = Math.max(0, MOCK_FALLBACK_DELAY_MS - (now() - routeStartedAt));
    if (remainingDelay > 0) {
      attempts.push({ provider: "mock", error: `delayed ${remainingDelay}ms before fallback` });
      await sleep(remainingDelay);
    }
    return { result: mockModel(conversation), provider: "mock", model: "mock", latency_ms: now() - routeStartedAt, attempts, cache_hit: false };
  }
  const error = new Error("All LLM providers failed");
  error.statusCode = 503;
  error.attempts = attempts;
  throw error;
}

function publicDebug(routed) {
  return {
    provider: routed.provider,
    model: routed.model,
    latency_ms: routed.latency_ms,
    cache_hit: routed.cache_hit,
    provider_order: PROVIDER_ORDER,
    safety_gate: routed.result.safety,
    attempts: routed.attempts,
    provider_health: providerHealthSnapshot()
  };
}

async function handleChat(req, res) {
  if (req.method === "OPTIONS") return sendJson(req, res, 200, { ok: true });
  if (req.method !== "POST") return sendJson(req, res, 405, { error: "Method not allowed" });
  if (!isAllowedOrigin(req, getOrigin(req))) return sendJson(req, res, 403, { error: "Origin not allowed" });
  const rate = checkRateLimit(req);
  if (!rate.ok) return sendJson(req, res, 429, { error: "Too many requests", reset_at: rate.resetAt });
  try {
    const body = await readBody(req);
    const payload = JSON.parse(body || "{}");
    const conversation = extractConversation(payload);
    validatePayload(payload, conversation);
    const emotionState = analyzeUserEmotion(conversation.user_input);
    conversation.emotion_state = emotionState;
    if (wantsCurrentEvents(conversation.user_input) || /開話題|找話題|聊什麼|你決定|你主動|不知道聊什麼|換個話題|陪我聊/.test(conversation.user_input)) {
      conversation.current_events = await getCurrentNews(5);
    }
    if (wantsWebLookup(conversation.user_input)) {
      conversation.web_facts = await getWebFacts(conversation.user_input);
    }
    const user = await getAuthUser(req);
    let effectivePayload = payload;
    let effectiveConversation = conversation;
    if (user) {
      const loverProfile = conversation.lover_profile || {};
      await upsertProfile(user.id, {
        lover_name: "Samantha",
        user_name: loverProfile.user_name,
        tone: loverProfile.tone,
        companion_mode: loverProfile.companion_mode,
        intimacy: conversation.intimacy
      });
      if (Array.isArray(conversation.long_term_memory)) await mergeMemories(user.id, conversation.long_term_memory);
      effectiveConversation = await hydrateConversationForUser(user.id, conversation);
      effectivePayload = replaceConversationInPayload(payload, effectiveConversation);
      const characterKey = normalizeCharacterKey(effectiveConversation?.lover_profile?.character_key || "samantha");
      const loverName = "Samantha";
      const userMessage = await addMessage(user.id, "user", conversation.user_input, {
        emotion: emotionState.primary_emotion,
        emotion_intensity: emotionState.intensity,
        emotional_need: emotionState.need,
        emotion_valence: emotionState.valence,
        character_key: characterKey,
        lover_name: loverName
      });
      await addEmotionEvent(user.id, userMessage?.id, emotionState, conversation.user_input);
    }
    if (!user) {
      effectivePayload = replaceConversationInPayload(payload, effectiveConversation);
    }
    const routed = await routeProviders(effectivePayload, effectiveConversation);
    const response = { ...routed.result };
    if (user) {
      await addMessage(user.id, "lover", routed.result.reply, {
        safety: routed.result.safety,
        emotion: routed.result.emotion,
        provider: routed.provider,
        character_key: normalizeCharacterKey(effectiveConversation?.lover_profile?.character_key || "samantha"),
        lover_name: "Samantha"
      });
      await mergeMemories(user.id, routed.result.memory_patch || []);
      const characterKey = normalizeCharacterKey(effectiveConversation?.lover_profile?.character_key || "samantha");
      const relationship = await updateCharacterRelationship(user.id, characterKey, "Samantha", emotionState, routed.result);
      response.relationship = {
        character_key: relationship.character_key,
        lover_name: relationship.lover_name,
        intimacy: relationship.intimacy,
        trust: relationship.trust,
        conversation_count: relationship.conversation_count,
        last_emotion: relationship.last_emotion
      };
    }
    response.emotion_state = emotionState;
    if (EXPOSE_DEBUG) response.debug = publicDebug(routed);
    return sendJson(req, res, 200, response);
  } catch (error) {
    const status = error.statusCode || 400;
    const message = status === 503 ? "AI providers are temporarily unavailable" : (IS_PROD ? "Bad request" : sanitizeError(error.message));
    return sendJson(req, res, status, { error: message });
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
      mock: ENABLE_MOCK_FALLBACK
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
    codex: {
      backend: CODEX_BACKEND,
      timeout_ms: CODEX_TIMEOUT_MS,
      api_configured: Boolean(CODEX_API_KEY),
      worker_configured: Boolean(CODEX_WORKER_URL),
      cli_command: CODEX_COMMAND
    },
    gemini: { timeout_ms: GEMINI_TIMEOUT_MS },
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
  const pathname = new URL(req.url, `http://localhost:${PORT}`).pathname;
  if (pathname.startsWith("/api/admin/")) return handleAdmin(req, res, pathname);
  if (pathname.startsWith("/api/auth/") || pathname.startsWith("/api/user/")) return handleAuth(req, res, pathname);
  if (req.url.startsWith("/api/cloud-lover/chat")) return handleChat(req, res);
  if (req.url.startsWith("/api/provider/status")) return handleProviderStatus(req, res);
  if (req.url.startsWith("/healthz")) return sendJson(req, res, 200, { ok: true });
  return serveFile(req, res);
});

server.listen(PORT, () => {
  console.log(`Cloud Lover running on http://localhost:${PORT}`);
});
