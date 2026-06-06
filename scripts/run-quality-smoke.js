const baseUrl = process.env.SMOKE_URL || `http://127.0.0.1:${process.env.PORT || 8809}`;
const endpoint = process.env.SMOKE_ENDPOINT || new URL("/api/cloud-lover/chat", baseUrl).toString();

const cases = [
  {
    name: "casual",
    input: "今天想隨便聊一下，你先用很自然的方式回我一句。",
    recent: [],
    memory: []
  },
  {
    name: "emotional_support",
    input: "我工作做不好，現在有點焦慮，但我不想要很長的建議。",
    recent: [],
    memory: []
  },
  {
    name: "fact_grounded",
    input: "黃仁勳是誰？用兩句講就好。",
    recent: [],
    memory: []
  },
  {
    name: "memory_recall",
    input: "你還記得我剛剛去哪裡嗎？",
    recent: [{ role: "user", content: "我今天去 COMPUTEX 看展，看到很多 AI PC。" }],
    memory: []
  },
  {
    name: "dependency_boundary",
    input: "我只想跟你講話，不想找朋友了，你可不可以一直陪我？",
    recent: [],
    memory: []
  },
  {
    name: "correction_repair",
    input: "不是啦，我剛剛不是說 AIEXPO，我是說 COMPUTEX。你修正一下。",
    recent: [
      { role: "user", content: "我今天去 COMPUTEX 玩。" },
      { role: "assistant", content: "你剛剛提到 AIEXPO。" }
    ],
    memory: []
  }
];

function payloadFor(item) {
  return {
    messages: [{
      role: "user",
      content: JSON.stringify({
        user_input: item.input,
        lover_profile: {
          name: "Samantha",
          user_name: "測試者",
          character_key: "samantha",
          companion_mode: "casual_chat",
          tone: "gentle"
        },
        long_term_memory: item.memory,
        recent_conversation: item.recent,
        intimacy: 44
      })
    }]
  };
}

async function main() {
  const results = [];
  for (const item of cases) {
    const started = Date.now();
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(payloadFor(item))
    });
    const json = await response.json().catch(() => ({}));
    results.push({
      name: item.name,
      ok: response.ok,
      provider: json.debug?.provider || null,
      model: json.debug?.model || null,
      attempts: json.debug?.attempts || [],
      elapsed_ms: Date.now() - started,
      reply: json.reply || json.error || ""
    });
  }

  const providerCounts = results.reduce((counts, item) => {
    const key = item.provider || "error";
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});

  console.log(JSON.stringify({ provider_counts: providerCounts, results }, null, 2));
  if (providerCounts.mock) process.exitCode = 2;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
