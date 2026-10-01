// Thin wrapper around the Anthropic Messages API. Returns null when no key is set or the call fails.
export async function complete({ cfg, system, user, maxTokens = 700, fetchImpl = fetch }) {
  if (!cfg.anthropicApiKey) return null;
  try {
    const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': cfg.anthropicApiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: cfg.anthropicModel, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`anthropic ${res.status}`);
    const data = await res.json();
    return data.content?.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim() || null;
  } catch (e) {
    console.error('llm error:', e.message);
    return null;
  }
}

// Messages API with the server-side web search tool. Handles `pause_turn` by continuing the same turn.
// Needs web search enabled for the organisation in the Anthropic Console.
export async function completeWithSearch({ cfg, system, user, maxTokens = 2000, maxSearches = 5, country, fetchImpl = fetch }) {
  if (!cfg.anthropicApiKey) return null;
  const tool = { type: 'web_search_20260209', name: 'web_search', max_uses: maxSearches };
  if (country) tool.user_location = { type: 'approximate', country };
  const messages = [{ role: 'user', content: user }];
  try {
    for (let turn = 0; turn < 4; turn++) {
      const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': cfg.anthropicApiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: cfg.anthropicModel, max_tokens: maxTokens, system, tools: [tool], messages }),
        signal: AbortSignal.timeout(90_000),
      });
      if (!res.ok) throw new Error(`anthropic ${res.status}`);
      const data = await res.json();
      if (data.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: data.content }); continue; }
      return data.content?.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim() || null;
    }
  } catch (e) {
    console.error('llm search error:', e.message);
  }
  return null;
}
