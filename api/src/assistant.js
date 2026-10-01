const PLATFORMS = {
  instagram: { name: 'Instagram', budget: 20, leads: 35 },
  facebook: { name: 'Facebook', budget: 20, leads: 30 },
  google: { name: 'Google', budget: 18, leads: 28 },
  tiktok: { name: 'TikTok', budget: 15, leads: 25 },
  chatgpt: { name: 'ChatGPT Ads', budget: 30, leads: 22 },
};

// Returns a campaign draft if the message asks to create one for a known platform.
export function detectCampaignRequest(text, business) {
  const t = text.toLowerCase();
  if (!/(create|build|make|launch|start|new)/.test(t) || !/campaign|ads?\b/.test(t)) return null;
  const key = Object.keys(PLATFORMS).find((k) => t.includes(k));
  if (!key) return null;
  const p = PLATFORMS[key];
  const goal = business?.goal || 'New customers';
  return {
    title: `${goal} — ${p.name}`,
    platform: p.name,
    budget_per_day: p.budget,
    duration_days: 7,
    audience: business?.customer_location ? `${business.customer_location}, ${business.customer_age || '25-44'}` : 'Local, 25-44',
    expected_leads: p.leads,
  };
}

function fallbackReply(text, campaign) {
  if (campaign) {
    return `I've drafted a ${campaign.platform} campaign (${campaign.budget_per_day}$/day for ${campaign.duration_days} days). It's waiting for your approval in Campaigns — nothing spends until you approve it.`;
  }
  const t = text.toLowerCase();
  if (/customer|lead|sales/.test(t)) return 'To get more customers, start with a local campaign. Tell me the platform (Instagram, Facebook, Google, TikTok or ChatGPT) and I will draft it for your approval.';
  if (/competitor/.test(t)) return 'Competitor monitoring needs ad-platform access, which is not connected yet. For now, tell me who your competitors are and I can suggest how to position against them.';
  return 'Got it. Tell me your goal and a platform, for example "Create an Instagram campaign", and I will prepare a draft for you to approve.';
}

export async function assistantReply({ cfg, business, history, text, campaign, fetchImpl = fetch }) {
  if (!cfg.anthropicApiKey) return fallbackReply(text, campaign);
  const system = [
    'You are Postly, an AI marketing assistant for a small business. Be concise and practical (max ~120 words).',
    'You can only draft campaigns for the owner to approve; never claim anything was launched or spent.',
    `Business: ${business?.name || 'unknown'} (${business?.industry || 'n/a'}), goal: ${business?.goal || 'n/a'}, budget: ${business?.budget || 'n/a'}, location: ${business?.location || 'n/a'}.`,
    campaign ? `A draft ${campaign.platform} campaign (${campaign.budget_per_day}$/day, ${campaign.duration_days} days) was just created and awaits approval; mention that.` : '',
  ].filter(Boolean).join('\n');
  try {
    const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': cfg.anthropicApiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: cfg.anthropicModel,
        max_tokens: 500,
        system,
        messages: [...history, { role: 'user', content: text }],
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`anthropic ${res.status}`);
    const data = await res.json();
    const out = data.content?.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
    return out || fallbackReply(text, campaign);
  } catch (e) {
    console.error('assistant error:', e.message);
    return fallbackReply(text, campaign);
  }
}
