import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createPool, migrate } from '../src/db.js';
import { extractImage, createImageClient, sanitizeIdeas, fallbackIdeas, withRules, ImageError } from '../src/images.js';

const DB = process.env.TEST_DATABASE_URL || 'postgres://postgres@localhost:5433/postly_test';
const cfg = { trustProxyHops: 0, sessionDays: 1, adminEmails: ['boss@i.com'], adminApiKey: '', anthropicApiKey: 'KEY', anthropicModel: 'claude-sonnet-5-5', searchModel: 'claude-haiku-4-5',
  geminiApiKey: 'GKEY', imageModel: 'models/gemini-3.1-flash-lite-image', imagesPerDay: 3,
  helpName: 'Hostbotics', helpUrl: 'https://hostbotics.net/', whatsapp: {}, whatsappEnabled: false, webhookEnabled: false };

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');       // enough bytes to look like a PNG header
const okResult = (mime = 'image/png', buf = PNG) => ({ steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Here you go' }, { type: 'image', mime_type: mime, data: buf.toString('base64') }] }] });

let pool, server, url, script, genImpl;
let llmCalls = [], genCalls = [];
before(async () => {
  pool = createPool(DB);
  await migrate(pool, { retries: 2, delayMs: 200 });
  await pool.query('truncate users cascade');
  const llm = async (_u, o) => { llmCalls.push(JSON.parse(o.body)); return new Response(JSON.stringify(script.shift() ?? { content: [{ type: 'text', text: 'ok' }] }), { status: 200 }); };
  const imageClient = { generate: async (prompt, aspect) => { genCalls.push({ prompt, aspect }); return genImpl(prompt, aspect); } };
  server = createApp(cfg, { pool, fetchImpl: llm, imageClient, imageEnabled: true, fetchPage: async () => '<html>ok</html>' }).listen(0);
  url = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

function client() {
  let cookie = '';
  const call = async (method, path, body) => {
    const res = await fetch(url + path, { method, headers: { 'content-type': 'application/json', ...(cookie && { cookie }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie?.() ?? []) cookie = c.split(';')[0];
    const buf = Buffer.from(await res.arrayBuffer()); const text = buf.toString('utf8'); let json; try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text, buf, headers: res.headers };
  };
  return { get: (p) => call('GET', p), post: (p, b = {}) => call('POST', p, b), del: (p) => call('DELETE', p, {}), put: (p, b) => call('PUT', p, b) };
}
const tool = (platform) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'create_campaign_draft', input: { platform } }] });
const txt = (t) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: t }] });
async function userWithCampaign(email) {
  const c = client(); await c.post('/api/auth/register', { email, password: 'correct horse 1', businessName: 'Einvite' });
  await c.put('/api/business', { description: 'Digital wedding invitations', country: 'Lebanon' });
  script = [tool('Instagram'), txt('{}'), txt('done')];
  const id = (await c.post('/api/chat', { message: 'Create an Instagram campaign for me.' })).json.campaign.id;
  return { c, id };
}

test('extractImage reads Google Interactions steps; bad data and errors are handled', () => {
  const r = extractImage(okResult('image/jpeg'));
  assert.equal(r.mime, 'image/jpeg'); assert.deepEqual(r.buffer, PNG);
  assert.equal(extractImage(okResult('text/html')).mime, 'image/png');                  // unknown mime is never served as-is
  assert.equal(extractImage({ steps: [{ type: 'model_output', content: [{ type: 'text', text: 'no' }] }] }), null);
  assert.equal(extractImage({ steps: [] }), null);
  assert.equal(extractImage(undefined), null);
  assert.throws(() => extractImage({ steps: [{ type: 'model_output', error: { message: 'x' }, content: [] }] }), ImageError);
});

test('Google client: documented request shape, key never in the body, retry without response_format, clear error when no image', async () => {
  const calls = [];
  const fake = { interactions: { create: async (b) => { calls.push(b); return okResult(); } } };
  const g = createImageClient(cfg, { client: fake });
  const img = await g.generate('A cup of coffee on a wooden table', '4:5');
  assert.equal(img.mime, 'image/png');
  const b = calls[0];
  assert.equal(b.model, 'models/gemini-3.1-flash-lite-image');
  assert.equal(b.input, 'A cup of coffee on a wooden table');
  assert.deepEqual(b.response_modalities, ['image', 'text']);
  assert.equal(b.generation_config.thinking_level, 'minimal');
  assert.equal(b.store, false);
  assert.deepEqual(b.response_format, { type: 'image', aspect_ratio: '4:5', mime_type: 'image/jpeg' });
  assert.ok(!JSON.stringify(b).includes('GKEY'));

  const seq = []; let n = 0;
  const flaky = { interactions: { create: async (b) => { seq.push(b); if (n++ === 0) throw Object.assign(new Error('400 invalid argument: response_format'), { status: 400 }); return okResult(); } } };
  await createImageClient(cfg, { client: flaky }).generate('A red apple on a table', '9:16');
  assert.equal(seq.length, 2);
  assert.equal(seq[1].response_format, undefined);
  assert.match(seq[1].input, /Aspect ratio: 9:16/);

  const down = { interactions: { create: async () => { throw Object.assign(new Error('503 unavailable'), { status: 503 }); } } };
  await assert.rejects(createImageClient(cfg, { client: down }).generate('x'.repeat(20)), /503/);       // not retried, not swallowed
  const empty = { interactions: { create: async () => ({ steps: [] }) } };
  await assert.rejects(createImageClient(cfg, { client: empty }).generate('x'.repeat(20)), ImageError);
});

test('image ideas: Claude writes them with safety rules; fallback when it does not', async () => {
  const { c, id } = await userWithCampaign('i1@i.com');
  llmCalls = []; script = [txt(JSON.stringify([
    { title: 'Phone preview', prompt: 'A smartphone showing a soft pink digital wedding invitation on a marble table, morning light, shallow depth of field, calm romantic mood, top-down angle, pastel colours', aspect: '4:5' },
    { title: 'Couple hands', prompt: 'Close-up of two hands holding a phone with an elegant invitation, warm candle light, cosy atmosphere, shallow focus, golden tones', aspect: '9:16' },
    { title: 'Bad aspect', prompt: 'Flat lay of wedding stationery with dried flowers and a tablet, bright airy daylight, neutral palette, top-down view', aspect: '7:3' },
  ]))];
  const r = await c.post(`/api/campaigns/${id}/image-ideas`);
  assert.equal(r.status, 200); assert.equal(r.json.ai, true);
  assert.equal(r.json.ideas.length, 3);
  assert.equal(r.json.ideas[2].aspect, '1:1');                                  // unknown ratio falls back
  assert.ok(r.json.ideas.every((x) => /No text, letters/.test(x.prompt)));      // rules always included
  assert.match(llmCalls[0].system, /No text, letters, logos/);
  script = [txt('nope')];
  const f = await c.post(`/api/campaigns/${id}/image-ideas`);
  assert.equal(f.json.ai, false); assert.ok(f.json.ideas.length >= 2);
  assert.deepEqual(sanitizeIdeas('x'), []);
  assert.ok(fallbackIdeas({ business: {}, brief: null }).every((x) => x.prompt.length > 20));
  const other = await userWithCampaign('i2@i.com');
  assert.equal((await other.c.post(`/api/campaigns/${id}/image-ideas`)).status, 404);
});

test('generate, store, serve (owner only, safe headers), download, delete', async () => {
  const { c, id } = await userWithCampaign('i3@i.com');
  genCalls = []; genImpl = async () => ({ mime: 'image/png', buffer: PNG });
  const r = await c.post(`/api/campaigns/${id}/images`, { prompt: 'A soft pink invitation on a phone', aspect: '4:5' });
  assert.equal(r.status, 201);
  const img = r.json.image;
  assert.ok(!('data' in img));
  assert.equal(genCalls[0].aspect, '4:5');
  assert.match(genCalls[0].prompt, /No text, letters/);                       // server adds the rules
  assert.match(genCalls[0].prompt, /soft pink invitation/);

  const got = await c.get(`/api/images/${img.id}`);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'image/png');
  assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
  assert.match(got.headers.get('cache-control'), /private/);
  assert.match(got.headers.get('content-disposition'), /^inline;/);
  assert.deepEqual(got.buf, PNG);
  assert.match((await c.get(`/api/images/${img.id}?download=1`)).headers.get('content-disposition'), /^attachment; filename="postly-ad-[0-9a-f]{8}-4x5\.png"/);
  assert.equal((await c.get(`/api/campaigns/${id}/images`)).json.images.length, 1);

  const other = client(); await other.post('/api/auth/register', { email: 'i4@i.com', password: 'correct horse 1' });
  assert.equal((await other.get(`/api/images/${img.id}`)).status, 404);
  assert.equal((await other.del(`/api/images/${img.id}`)).status, 200);        // no-op for a stranger
  assert.equal((await c.get(`/api/images/${img.id}`)).status, 200);
  assert.equal((await client().get(`/api/images/${img.id}`)).status, 401);

  await c.del(`/api/images/${img.id}`);
  assert.equal((await c.get(`/api/images/${img.id}`)).status, 404);
});

test('validation, daily limit, operators exempt, errors never leak the key, 503 without a key', async () => {
  const { c, id } = await userWithCampaign('i5@i.com');
  genCalls = []; genImpl = async () => ({ mime: 'image/png', buffer: PNG });
  assert.equal((await c.post(`/api/campaigns/${id}/images`, { prompt: 'short' })).status, 400);
  assert.equal((await c.post(`/api/campaigns/${id}/images`, { prompt: 'x'.repeat(2000) })).status, 400);
  assert.equal((await c.post(`/api/campaigns/00000000-0000-0000-0000-000000000000/images`, { prompt: 'A long enough prompt here' })).status, 404);
  assert.equal((await c.post(`/api/campaigns/${id}/images`, { prompt: 'A long enough prompt here', aspect: '7:3' })).status, 201);
  assert.equal(genCalls[0].aspect, '1:1');
  for (let i = 0; i < 2; i++) assert.equal((await c.post(`/api/campaigns/${id}/images`, { prompt: `Another long prompt number ${i}` })).status, 201);
  const limited = await c.post(`/api/campaigns/${id}/images`, { prompt: 'One more long enough prompt' });
  assert.equal(limited.status, 429); assert.match(limited.json.error, /3 images per day/);

  const { c: d, id: did } = await userWithCampaign('i6@i.com');
  genImpl = async () => { throw Object.assign(new Error('500 internal GKEY leaked?'), { status: 500 }); };
  const bad = await d.post(`/api/campaigns/${did}/images`, { prompt: 'A long enough prompt here' });
  assert.equal(bad.status, 502); assert.ok(!bad.text.includes('GKEY'));
  genImpl = async () => { throw new ImageError('The model did not return an image'); };
  const none = await d.post(`/api/campaigns/${did}/images`, { prompt: 'A long enough prompt here' });
  assert.equal(none.status, 422);
  assert.equal((await d.get(`/api/campaigns/${did}/images`)).json.images.length, 0);   // failures store nothing

  const s2 = createApp({ ...cfg, geminiApiKey: '' }, { pool, imageEnabled: false }).listen(0);
  const b2 = `http://127.0.0.1:${s2.address().port}`;
  const lg = await fetch(b2 + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'i5@i.com', password: 'correct horse 1' }) });
  const ck = lg.headers.getSetCookie()[0].split(';')[0];
  const r = await fetch(`${b2}/api/campaigns/${id}/images`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: ck }, body: JSON.stringify({ prompt: 'A long enough prompt here' }) });
  assert.equal(r.status, 503);
  s2.close();
});

test('withRules adds the safety rules once', () => {
  assert.match(withRules('A cup'), /No text, letters/);
  const once = withRules('A cup'); assert.equal(withRules(once), once);
});
