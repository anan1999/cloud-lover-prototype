# 雲端戀人 Prototype

一個可部署的 AI 伴侶聊天原型，支援多 provider 自動 fallback：

```text
Gemini -> NVIDIA -> OpenRouter -> Groq -> Codex(local only) -> Mock
```

## 本機啟動

```powershell
cd C:\Users\hi\Documents\Codex\2026-06-04\new-chat\outputs
.\start-cloud-lover.ps1
```

打開：

```text
http://localhost:8787
```

## 外網分享

### 臨時給朋友玩

用 tunnel 工具把本機服務公開，例如 Cloudflare Tunnel 或 ngrok：

```powershell
cloudflared tunnel --url http://localhost:8787
```

或：

```powershell
ngrok http 8787
```

### 正式上線

部署到 Render、Railway、Fly.io、VPS 或其他 Node hosting。

部署時設定環境變數，不要上傳 `.env.local`：

```text
PROVIDER_ORDER=gemini,nvidia,openrouter,groq,mock
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.5-flash
OPENROUTER_API_KEY=...
OPENROUTER_MODELS=qwen/qwen3-next-80b-a3b-instruct:free,google/gemma-4-26b-a4b-it:free,google/gemma-4-31b-it:free,moonshotai/kimi-k2.6:free,nvidia/nemotron-3-nano-30b-a3b:free,liquid/lfm-2.5-1.2b-instruct:free
NVIDIA_API_KEY=...
NVIDIA_MODEL=google/gemma-3n-e2b-it
PROVIDER_TIMEOUT_MS=12000
CACHE_TTL_MS=120000
PROVIDER_COOLDOWN_MS=60000
```

Codex provider 只適合本機開發，不建議放到正式部署環境。

## Git 注意

`.env.local` 已被 `.gitignore` 排除，避免 API key 被 commit。
