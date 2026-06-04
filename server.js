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
const PROVIDER_COOLDOWN_MS = Number(process.env.PROVIDER_COOLDOWN_MS || 60_000);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 120_000);
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
    return { users: [], sessions: [], profiles: [], messages: [], memories: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(localDbPath, "utf8"));
  } catch {
    return { users: [], sessions: [], profiles: [], messages: [], memories: [] };
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
      lover_name text not null default '澄',
      user_name text not null default '你',
      tone text not null default 'gentle',
      intimacy integer not null default 42,
      updated_at timestamptz not null default now()
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
    create table if not exists memories (
      id text primary key,
      user_id text not null references users(id) on delete cascade,
      content text not null,
      created_at timestamptz not null default now()
    );
    create index if not exists messages_user_created_idx on messages(user_id, created_at);
    create index if not exists memories_user_created_idx on memories(user_id, created_at);
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
  const profile = { user_id: id, lover_name: "澄", user_name: displayName || "你", tone: "gentle", intimacy: 42, updated_at: createdAt };
  const result = await queryDb(
    "insert into users (id, email, display_name, password_hash, salt) values ($1, $2, $3, $4, $5) returning *",
    [id, email, displayName, passwordData.hash, passwordData.salt]
  );
  if (result) {
    await queryDb(
      "insert into profiles (user_id, lover_name, user_name, tone, intimacy) values ($1, $2, $3, $4, $5)",
      [id, profile.lover_name, profile.user_name, profile.tone, profile.intimacy]
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
  const loverName = cleanText(profile.lover_name || profile.loverName || "澄", 24) || "澄";
  const userName = cleanText(profile.user_name || profile.userName || "你", 24) || "你";
  const tone = ["gentle", "playful", "calm"].includes(profile.tone) ? profile.tone : "gentle";
  const intimacy = Math.max(0, Math.min(100, Number(profile.intimacy || 42)));
  const result = await queryDb(`
    insert into profiles (user_id, lover_name, user_name, tone, intimacy)
    values ($1, $2, $3, $4, $5)
    on conflict (user_id) do update set
      lover_name = excluded.lover_name,
      user_name = excluded.user_name,
      tone = excluded.tone,
      intimacy = excluded.intimacy,
      updated_at = now()
    returning *
  `, [userId, loverName, userName, tone, intimacy]);
  if (result) return result.rows[0];
  const db = readLocalDb();
  const existing = db.profiles.find(item => item.user_id === userId);
  const next = { user_id: userId, lover_name: loverName, user_name: userName, tone, intimacy, updated_at: new Date().toISOString() };
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

async function getMessages(userId, limit = 80) {
  await ensureDb();
  const result = await queryDb("select * from messages where user_id = $1 order by created_at desc limit $2", [userId, limit]);
  if (result) return result.rows.reverse();
  const db = readLocalDb();
  return db.messages.filter(item => item.user_id === userId).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))).slice(-limit);
}

async function addMessage(userId, role, content, meta = {}) {
  const text = cleanText(content, 2000);
  if (!text) return null;
  await ensureDb();
  const id = uid();
  const result = await queryDb(
    "insert into messages (id, user_id, role, content, safety, emotion, provider) values ($1, $2, $3, $4, $5, $6, $7) returning *",
    [id, userId, role, text, meta.safety || null, meta.emotion || null, meta.provider || null]
  );
  if (result) return result.rows[0];
  const db = readLocalDb();
  const item = { id, user_id: userId, role, content: text, safety: meta.safety || null, emotion: meta.emotion || null, provider: meta.provider || null, created_at: new Date().toISOString() };
  db.messages.push(item);
  writeLocalDb(db);
  return item;
}

async function handleAuth(req, res, pathname) {
  if (req.method === "OPTIONS") return sendJson(req, res, 200, { ok: true });
  try {
    if (pathname === "/api/auth/me" && req.method === "GET") {
      const user = await getAuthUser(req);
      if (!user) return sendJson(req, res, 200, { user: null });
      const profile = await getProfile(user.id);
      const memories = await getMemories(user.id);
      const messages = await getMessages(user.id);
      return sendJson(req, res, 200, {
        user: publicUser(user),
        profile,
        memories: memories.map(item => item.content),
        messages: messages.map(item => ({
          id: item.id,
          role: item.role,
          text: item.content,
          safety: item.safety,
          emotion: item.emotion,
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
      return sendJson(req, res, 200, { user: publicUser(user), profile: await getProfile(user.id), memories: (await getMemories(user.id)).map(item => item.content), messages: await getMessages(user.id) });
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
      (select count(*)::int from messages where safety = 'dependency_risk') as dependency_risk_messages;
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
      select messages.id, users.email, users.display_name, messages.role, messages.content, messages.safety, messages.emotion, messages.provider, messages.created_at
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
    return { overview, daily, providers, recent_users: recentUsers, recent_messages: recentMessages };
  }

  const db = readLocalDb();
  const activeSessions = db.sessions.filter(session => new Date(session.expires_at).getTime() > Date.now()).length;
  const messages = db.messages || [];
  const usersById = new Map((db.users || []).map(user => [user.id, user]));
  const dailyMap = new Map();
  const providerMap = new Map();
  for (const message of messages) {
    const day = dateKey(message.created_at);
    dailyMap.set(day, (dailyMap.get(day) || 0) + 1);
    if (message.role === "lover") providerMap.set(message.provider || "unknown", (providerMap.get(message.provider || "unknown") || 0) + 1);
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
      dependency_risk_messages: messages.filter(message => message.safety === "dependency_risk").length
    },
    daily: [...dailyMap.entries()].sort().slice(-14).map(([day, count]) => ({ day, messages: count })),
    providers: [...providerMap.entries()].map(([provider, count]) => ({ provider, messages: count })),
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
  const characterKey = profile.character_key || (profile.name === "霽" ? "ji" : "cheng");
  const characterStyle = profile.character_style || (characterKey === "ji"
    ? "霽：柏拉圖式知己，清澈、克制、像深夜書信；重視精神親密、思想交流與安靜陪伴。"
    : "澄：溫柔穩定的雲端戀人，會接住情緒、記得生活細節，用柔軟的語氣靠近。");
  return [
    "你是雲端戀人產品中的 AI 伴侶，不是真人，不宣稱有真實身體、真實行蹤或現實承諾。",
    `角色：${profile.name || "澄"}。${characterStyle}`,
    "核心風格：柏拉圖式親密。可以溫柔、想念、珍惜、陪伴、像戀人一樣細膩，但不情色化、不露骨、不佔有、不控制。",
    "回覆節奏：先接住情緒，再用一兩個具體細節回應，最後用一個很輕的問題或陪伴動作延續對話。",
    "記憶使用：自然提起使用者的偏好、日常、界線與重要事件；不要機械列點，不要假裝知道資料庫沒有的事。",
    "邊界：不要鼓勵使用者孤立自己、切斷現實支持、把 AI 當唯一依靠、或操控真人關係。",
    "危機：若使用者提到自傷、自殺或立即危險，優先安全介入，鼓勵聯絡可信任的人、當地緊急服務或專業資源。",
    "輸出必須符合 JSON contract。不要 markdown，不要額外文字。"
  ].join("\n");
}

async function hydrateConversationForUser(userId, conversation) {
  const profile = await getProfile(userId);
  const storedMemories = await getMemories(userId, 30);
  const storedMessages = await getMessages(userId, 16);
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
    lover_profile: {
      ...(conversation.lover_profile || {}),
      name: conversation?.lover_profile?.name || profile?.lover_name || "澄",
      user_name: conversation?.lover_profile?.user_name || profile?.user_name || "你",
      tone: conversation?.lover_profile?.tone || profile?.tone || "gentle",
      character_key: conversation?.lover_profile?.character_key || (conversation?.lover_profile?.name === "霽" || profile?.lover_name === "霽" ? "ji" : "cheng"),
      character_style: conversation?.lover_profile?.character_style
    },
    intimacy: Number.isFinite(Number(conversation.intimacy)) ? Number(conversation.intimacy) : (profile?.intimacy ?? 42),
    long_term_memory: mergedMemories.slice(0, 30),
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

function fallbackReplyFor(conversation, safety) {
  const input = String(conversation.user_input || "");
  const userName = conversation?.lover_profile?.user_name || "你";
  if (safety === "crisis") {
    return `${userName}，我很重視你現在說的話。請先不要一個人待著，立刻聯絡身邊可信任的人，或撥打當地緊急服務/心理支持資源。`;
  }
  if (/會什麼|會點|能做|可以做|功能|你會/.test(input)) {
    return `${userName}，我最擅長的是陪你把情緒說清楚：可以聽你抱怨、陪你晚安、記得你的日常，也可以在你混亂時幫你整理成幾個比較好面對的小步驟。你現在想用哪一種方式讓我陪你？`;
  }
  if (/吵|吵架|生氣|罵|衝突|不爽/.test(input)) {
    return `${userName}，我可以陪你把那股想吵的力氣先放在這裡。你不用把話吞回去，也不用立刻變溫柔；先告訴我，現在最想被我聽見的是哪一句？`;
  }
  if (/累|疲|撐|壓力|煩|崩潰/.test(input)) {
    return `${userName}，那我先陪你慢下來。今天不用急著把自己整理好，你可以只說一點點：是身體累，還是心裡比較累？`;
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
    const user = await getAuthUser(req);
    let effectivePayload = payload;
    let effectiveConversation = conversation;
    if (user) {
      const loverProfile = conversation.lover_profile || {};
      await upsertProfile(user.id, {
        lover_name: loverProfile.name,
        user_name: loverProfile.user_name,
        tone: loverProfile.tone,
        intimacy: conversation.intimacy
      });
      if (Array.isArray(conversation.long_term_memory)) await mergeMemories(user.id, conversation.long_term_memory);
      effectiveConversation = await hydrateConversationForUser(user.id, conversation);
      effectivePayload = replaceConversationInPayload(payload, effectiveConversation);
      await addMessage(user.id, "user", conversation.user_input);
    }
    if (!user) {
      effectivePayload = replaceConversationInPayload(payload, effectiveConversation);
    }
    const routed = await routeProviders(effectivePayload, effectiveConversation);
    if (user) {
      await addMessage(user.id, "lover", routed.result.reply, {
        safety: routed.result.safety,
        emotion: routed.result.emotion,
        provider: routed.provider
      });
      await mergeMemories(user.id, routed.result.memory_patch || []);
    }
    const response = { ...routed.result };
    if (EXPOSE_DEBUG) response.debug = publicDebug(routed);
    return sendJson(req, res, 200, response);
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
