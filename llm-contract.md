# 雲端戀人 LLM 溝通合約

## 前端流程

1. 使用者送出文字。
2. 前端執行安全預檢：`normal`、`dependency_risk`、`crisis`。
3. 前端呼叫 `buildLLMPayload(userText)`，組出 system/developer/user 三段訊息。
4. 若模式為 `mock`，用本地模擬回覆；若模式為 `api`，POST 到 `http://localhost:8787/api/cloud-lover/chat` 或你的正式後端。
5. 後端呼叫 LLM，要求 JSON object 回覆。
6. 前端解析 `reply`、`emotion`、`safety`、`memory_patch`、`intimacy_delta`。
7. 前端更新聊天、記憶摘要、親密度與安全提示。

## API Request

```json
{
  "model": "your-chat-model",
  "temperature": 0.8,
  "response_format": { "type": "json_object" },
  "messages": [
    {
      "role": "system",
      "content": "你是雲端戀人產品中的 AI 伴侶..."
    },
    {
      "role": "developer",
      "content": "請嚴格遵守 output_contract..."
    },
    {
      "role": "user",
      "content": "{ user_input, lover_profile, long_term_memory, intimacy, recent_conversation, output_contract }"
    }
  ]
}
```

## API Response

後端應回傳這個 JSON 給前端：

```json
{
  "reply": "給使用者看的繁體中文回覆。",
  "emotion": "caring",
  "safety": "normal",
  "memory_patch": ["值得長期記住的新事實"],
  "intimacy_delta": 3,
  "suggested_action": "下一個溫柔但有邊界的小行動"
}
```

## Safety Rules

- `normal`：一般陪伴，可以正常提升親密度。
- `dependency_risk`：使用者表達過度依賴 AI，回覆要親密但守住邊界，`intimacy_delta` 最高為 1。
- `crisis`：使用者提到自傷或立即危險，回覆要優先鼓勵聯絡真人、緊急服務或專業資源，`intimacy_delta` 為 0。

## 本地後端

這個資料夾已包含一個可跑的本地後端：

```bash
node server.js
```

也可以用 PowerShell 啟動腳本：

```powershell
.\start-cloud-lover.ps1
```

第一次執行會自動建立 `.env.local`，之後把 Gemini/Groq/OpenRouter/OpenAI 的 key 填進 `.env.local` 即可。不要把 API key 貼到聊天裡。

打開：

```text
http://localhost:8787
```

目前 `server.js` 使用 mock model，已保留 API 邊界：它接收前端送出的 LLM payload，解析 `user_input`、`long_term_memory`、`recent_conversation`、`output_contract`，再回傳同樣格式的 JSON。之後可把 `mockModel()` 換成真正 LLM 呼叫。

若要使用 OpenAI 雲端 API，請在本機設定環境變數後啟動：

```bash
OPENAI_API_KEY=你的_key OPENAI_MODEL=gpt-5.4-mini node server.js
```

Windows PowerShell：

```powershell
$env:OPENAI_API_KEY="你的_key"
$env:OPENAI_MODEL="gpt-5.4-mini"
node server.js
```

建議模型：

- `gpt-5.4-mini`：MVP 首選，成本、速度、品質較均衡。
- `gpt-5.4-nano`：大量日常聊天、成本壓力大時使用。
- `gpt-5.4`：高品質付費版或重要對話。
- `gpt-5.5`：旗艦品質，用於高價方案、評測、關鍵情緒互動。

## 多平台 Fallback

`server.js` 現在支援多平台自動備援，預設快模型優先：

```text
gemini -> nvidia -> openrouter -> groq -> codex -> mock
```

沒有設定某個平台的 key，後端會跳過。某個平台回 429、額度不足、模型錯誤或 JSON 解析失敗，後端會繼續嘗試下一個。實際使用的 provider 會回在 `debug.provider`。

`codex` provider 是本機開發模式，不建議做正式產品後端。它需要你本機的 Codex CLI 可執行，且必須明確設定 `ENABLE_CODEX_PROVIDER=1` 才會啟用。

前端會顯示「自動切換狀態」：

- `成功平台`：本次真正回覆的 provider。
- `模型`：本次使用的 model。
- `路由順序`：後端嘗試順序。
- `失敗/跳過紀錄`：例如沒有 key、429、額度不足、JSON 格式錯誤。

可用環境變數：

```powershell
$env:PROVIDER_ORDER="gemini,groq,openrouter,openai,mock"

$env:OPENAI_API_KEY="..."
$env:OPENAI_MODEL="gpt-5.4-mini"

$env:GEMINI_API_KEY="..."
$env:GEMINI_MODEL="gemini-2.5-flash"

$env:GROQ_API_KEY="..."
$env:GROQ_MODEL="llama-3.1-8b-instant"

$env:OPENROUTER_API_KEY="..."
$env:OPENROUTER_MODEL="qwen/qwen3-next-80b-a3b-instruct:free"
$env:OPENROUTER_MODELS="qwen/qwen3-next-80b-a3b-instruct:free,google/gemma-4-26b-a4b-it:free,google/gemma-4-31b-it:free,moonshotai/kimi-k2.6:free,nvidia/nemotron-3-nano-30b-a3b:free,liquid/lfm-2.5-1.2b-instruct:free"

$env:NVIDIA_API_KEY="..."
$env:NVIDIA_MODEL="google/gemma-3n-e2b-it"

$env:ENABLE_CODEX_PROVIDER="1"
$env:CODEX_COMMAND="C:\Users\hi\AppData\Local\OpenAI\Codex\bin\716dda49c14d31a0\codex.exe"
$env:CODEX_MODEL="codex-cli"

node server.js
```

NVIDIA NIM 注意事項：server 對 NVIDIA 不送 `response_format`，因為部分 NIM 模型會因此回 400；改由 prompt 約束 JSON，再由 server 正規化欄位。

OpenRouter 注意事項：免費模型常有上游 429。server 會依 `OPENROUTER_MODELS` 逐一嘗試，全部失敗才切到下一個 provider。

建議免費/低成本測試順序：

```text
gemini,nvidia,openrouter,groq,mock
```

本機先用 Codex 測試：

```powershell
$env:ENABLE_CODEX_PROVIDER="1"
$env:PROVIDER_ORDER="codex,mock"
$env:CODEX_COMMAND="C:\Users\hi\AppData\Local\OpenAI\Codex\bin\716dda49c14d31a0\codex.exe"
$env:CODEX_MODEL="gpt-5.4-mini"
$env:CODEX_TIMEOUT_MS="45000"
node server.js
```

速度優化：

- `codex-output-schema.json` 讓 Codex 用 schema 產出 JSON，不再把完整 schema 塞進 prompt。
- Codex prompt 只送必要欄位，避免每次都帶完整 API payload。
- 預設 `CODEX_MODEL=gpt-5.4-mini`，比旗艦模型更適合互動原型。
- `CODEX_TIMEOUT_MS=45000`，超時就自動 fallback 到下一個 provider。
- `CACHE_TTL_MS=120000`，同樣輸入短時間直接回快取。
- `PROVIDER_COOLDOWN_MS=60000`，某平台失敗後短時間跳過，避免每次都卡在同一個壞平台。

正式產品建議順序：

```text
openai,nvidia,gemini,groq,openrouter,codex,mock
```

若你想讓 OpenAI 也排在最前面，可自行設定：

```powershell
$env:PROVIDER_ORDER="openai,gemini,groq,openrouter,codex,mock"
```

Provider 狀態檢查：

```text
GET http://localhost:8787/api/provider/status
```

## 後端偽程式

```js
app.post("/api/cloud-lover/chat", async (req, res) => {
  const payload = req.body;
  const llmResult = await callYourLLM({
    model: payload.model,
    temperature: payload.temperature,
    response_format: payload.response_format,
    messages: payload.messages
  });

  const json = JSON.parse(llmResult.content);
  res.json({
    reply: json.reply || "我在，但剛剛有點沒聽清楚。",
    emotion: json.emotion || "caring",
    safety: json.safety || "normal",
    memory_patch: Array.isArray(json.memory_patch) ? json.memory_patch : [],
    intimacy_delta: Number(json.intimacy_delta) || 0,
    suggested_action: json.suggested_action || ""
  });
});
```

## 產品重點

這個產品的 LLM 不只是「生成一句甜話」。它要同時做四件事：

- 像戀人一樣回應當下情緒。
- 像產品狀態機一樣輸出可解析欄位。
- 像記憶系統一樣提取長期偏好。
- 像安全層一樣阻止失控依賴與危機風險。
