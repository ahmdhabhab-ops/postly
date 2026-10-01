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
