import { complete } from './llm.js';

export const PLATFORMS = ['Instagram', 'Facebook', 'Google', 'TikTok', 'ChatGPT Ads'];
const FITS = ['Best fit', 'Good fit', 'Later', 'Skip for now'];
const S = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');

export function sanitizeAdvice(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const x of raw) {
    const platform = PLATFORMS.find((p) => p.toLowerCase() === S(x?.platform, 30).toLowerCase());
    if (!platform || seen.has(platform)) continue;
    seen.add(platform);
    const fit = FITS.find((f) => f.toLowerCase() === S(x?.fit, 20).toLowerCase()) || 'Good fit';
    const share = Math.max(0, Math.min(100, parseInt(x?.budget_share, 10) || 0));
    out.push({ platform, fit, why: S(x?.why, 260), budget_share: fit === 'Skip for now' || fit === 'Later' ? 0 : share, first_step: S(x?.first_step, 200) });
  }
  const rank = (a) => FITS.indexOf(a.fit);
  return out.sort((a, b) => rank(a) - rank(b));
}

// Plain guidance used when the AI is not available. Honest about being generic.
export function fallbackAdvice(b = {}) {
  const local = /local|service|restaurant|food|health|fitness|retail/i.test(`${b.type} ${b.industry}`);
  const visual = /food|retail|fashion|beauty|wedding|event|fitness|travel/i.test(`${b.industry} ${b.description}`);
  const rows = [
    { platform: 'Instagram', fit: visual ? 'Best fit' : 'Good fit', why: 'Visual platform with strong reach for consumer brands; good for showing products and results.', budget_share: 40, first_step: 'Start with one short Reel and one image ad to the same audience.' },
    { platform: 'Facebook', fit: 'Good fit', why: 'Broad audience and cheap reach, works well for local businesses and lead forms.', budget_share: 30, first_step: 'Run a lead or message campaign to a local audience.' },
    { platform: 'Google', fit: local ? 'Best fit' : 'Good fit', why: 'Reaches people already searching for what you sell, so intent is high.', budget_share: 30, first_step: 'Start with a few search keywords describing your offer.' },
    { platform: 'TikTok', fit: 'Later', why: 'Needs a steady stream of short videos; test it after your first channel works.', budget_share: 0, first_step: '' },
    { platform: 'ChatGPT Ads', fit: 'Later', why: 'New channel with a higher minimum budget; consider it once the basics perform.', budget_share: 0, first_step: '' },
  ];
  return rows;
}

export async function generateChannelAdvice({ cfg, business: b = {}, competitors = [], notes = [], fetchImpl }) {
  const markets = String(b.country || '').split('|').map((x) => x.trim()).filter(Boolean).join(', ');
  const out = await complete({
    cfg, fetchImpl, maxTokens: 3000, effort: 'medium',
    system: [
      'You are a media-planning advisor for a small business owner who is not an ad expert.',
      `Rank where this business should advertise, using ONLY these platforms: ${PLATFORMS.join(', ')}.`,
      'Output ONLY a JSON array with one object per platform: {"platform": string, "fit": "Best fit"|"Good fit"|"Later"|"Skip for now", "why": string (max 220 chars, plain language, specific to THIS business), "budget_share": number (percent of the monthly budget; recommended platforms sum to about 100, others 0), "first_step": string (max 160 chars)}.',
      'Base the reasoning on their offer, customers, markets, price, budget, goal, competitors and website readiness. Recommend at most 2-3 platforms to start; small budgets should focus on one or two.',
      'Do not invent facts or statistics. If key information is missing, still rank, and say what is assumed in "why".',
    ].join('\n'),
    user: [
      `Business: ${b.name || 'n/a'} (${b.industry || 'n/a'}, ${b.type || 'n/a'}); website: ${b.website || 'none'}; markets: ${markets || b.location || 'n/a'}`,
      `Offer: ${S(b.description, 600) || 'n/a'}; price: ${b.price_range || 'n/a'}; different because: ${S(b.usp, 300) || 'n/a'}`,
      `Goal: ${b.goal || 'n/a'}; monthly budget: ${b.budget || 'n/a'}; customers: age ${b.customer_age || '?'}, ${b.customer_type || '?'}, ${b.customer_location || '?'}, interests ${S(b.interests, 200) || '?'}`,
      competitors.length ? `Competitors: ${competitors.slice(0, 6).map((c) => `${c.name}${c.market ? ` [${c.market}]` : ''}`).join('; ')}` : '',
      notes.length ? `Website problems: ${notes.map((n) => S(n, 120)).join(' | ')}` : '',
    ].filter(Boolean).join('\n'),
  });
  let arr = null;
  if (out) {
    const a = out.indexOf('['); const z = out.lastIndexOf(']');
    try { if (a >= 0 && z > a) arr = sanitizeAdvice(JSON.parse(out.slice(a, z + 1))); } catch { /* fall through */ }
  }
  if (arr && arr.length >= 2) return { ai: true, advice: arr };
  return { ai: false, advice: sanitizeAdvice(fallbackAdvice(b)) };
}
