import { GoogleGenAI } from '@google/genai';
import { complete } from './llm.js';

export const ASPECTS = { '1:1': 'Square feed post', '4:5': 'Portrait feed post', '9:16': 'Story / Reel / TikTok', '16:9': 'Wide / link ad' };
export const MAX_PROMPT = 1200;
const SAFE_MIME = ['image/png', 'image/jpeg', 'image/webp'];

export class ImageError extends Error {}

// Every prompt sent to the image model carries the safety/style rules, even if the owner edited them away.
export const withRules = (prompt) => (String(prompt).includes('No text, letters') ? String(prompt) : `${prompt}\n\n${RULES}`);

const S = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');

// Pulls the first image out of an Interactions response ({ steps: [{ type: 'model_output', content: [{ type: 'image', data, mime_type }] }] }).
export function extractImage(interaction) {
  for (const step of interaction?.steps ?? []) {
    if (step?.type !== 'model_output') continue;
    if (step.error) throw new ImageError('The image model returned an error. Try a different description.');
    for (const part of step.content ?? []) {
      if (part?.type === 'image' && typeof part.data === 'string' && part.data) {
        const mime = SAFE_MIME.includes(part.mime_type) ? part.mime_type : 'image/png';
        const buffer = Buffer.from(part.data, 'base64');
        if (!buffer.length) continue;
        return { mime, buffer };
      }
    }
  }
  return null;
}

// Real client: Google's official SDK, key from the server environment only. `client` can be injected for tests.
export function createImageClient(cfg, { client } = {}) {
  let ai = client;
  const get = () => (ai ??= new GoogleGenAI({ apiKey: cfg.geminiApiKey }));

  async function create(prompt, aspect, withFormat) {
    const body = {
      model: cfg.imageModel,
      input: withFormat ? prompt : `${prompt}\n\nAspect ratio: ${aspect}.`,
      generation_config: { temperature: 1, max_output_tokens: 65536, top_p: 0.95, thinking_level: 'minimal' },
      response_modalities: ['image', 'text'],
      store: false,                       // do not keep the owner's prompts and images at Google
    };
    if (withFormat) body.response_format = { type: 'image', aspect_ratio: aspect, mime_type: 'image/jpeg' };
    return get().interactions.create(body);
  }

  return {
    async generate(prompt, aspect = '1:1') {
      let interaction;
      try {
        interaction = await create(prompt, aspect, true);
      } catch (e) {
        // If the API refuses the optional response_format, retry once with the ratio written into the prompt.
        if (!/40[0-9]|invalid|argument|unsupported/i.test(String(e?.status ?? e?.message))) throw e;
        interaction = await create(prompt, aspect, false);
      }
      const img = extractImage(interaction);
      if (!img) throw new ImageError('The model did not return an image (it may have declined this description). Try describing it differently.');
      return img;
    },
  };
}

// ---------- ideas: Claude writes image prompts from the campaign plan ----------
export const RULES = 'No text, letters, logos, watermarks or brand names inside the image. No identifiable real people or celebrities. No trademarked characters. Photorealistic or clean illustration style suitable for a social ad. Leave some empty space where the owner can add a headline later.';

export function fallbackIdeas({ business: b = {}, brief }) {
  const offer = S(b.description, 160) || b.name || 'the product';
  const ideas = [
    ...(brief?.creative?.ideas ?? []).slice(0, 2),
    `A clean, appealing scene that shows ${offer} being enjoyed`,
  ].slice(0, 3);
  return ideas.map((x, i) => ({ title: `Idea ${i + 1}`, prompt: `${S(x, 400)}. ${RULES}`.slice(0, MAX_PROMPT), aspect: i === 1 ? '9:16' : '1:1' }));
}

export function sanitizeIdeas(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 4).map((x, i) => ({
    title: S(x?.title, 60) || `Idea ${i + 1}`,
    prompt: S(x?.prompt, MAX_PROMPT),
    aspect: Object.keys(ASPECTS).includes(x?.aspect) ? x.aspect : '1:1',
  })).filter((x) => x.prompt.length > 10);
}

export async function suggestImageIdeas({ cfg, business, campaign, brief, fetchImpl }) {
  const out = await complete({
    cfg, fetchImpl, maxTokens: 2500, effort: 'low',
    system: [
      'You write image-generation prompts for social media ads of a small business.',
      `Output ONLY a JSON array of 3 objects {"title": string (max 5 words), "prompt": string (60-120 words, concrete: subject, setting, lighting, colours, mood, camera angle), "aspect": one of ${Object.keys(ASPECTS).join(', ')}}.`,
      `Mandatory rules for every prompt: ${RULES}`,
      'Make the 3 ideas clearly different. Base them on the business and the campaign plan only; do not invent product details that are not given.',
    ].join('\n'),
    user: `Business: ${business?.name || 'n/a'} (${business?.industry || 'n/a'}). Offer: ${S(business?.description, 400) || 'n/a'}. Different because: ${S(business?.usp, 200) || 'n/a'}.\nCampaign: ${campaign.title} on ${campaign.platform}. Objective: ${brief?.objective || 'n/a'}. Creative ideas: ${(brief?.creative?.ideas || []).join(' | ') || 'n/a'}. Formats: ${(brief?.creative?.formats || []).join(', ') || 'n/a'}.`,
  });
  let ideas = [];
  if (out) { const a = out.indexOf('['); const z = out.lastIndexOf(']'); try { if (a >= 0 && z > a) ideas = sanitizeIdeas(JSON.parse(out.slice(a, z + 1))); } catch { /* fallback */ } }
  // Even if the model forgot, the safety rules are always part of what is sent.
  ideas = ideas.map((x) => ({ ...x, prompt: x.prompt.includes('No text, letters') ? x.prompt : `${x.prompt} ${RULES}`.slice(0, MAX_PROMPT) }));
  return ideas.length >= 2 ? { ai: true, ideas } : { ai: false, ideas: fallbackIdeas({ business, brief }) };
}
