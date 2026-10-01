import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createPool, migrate } from '../src/db.js';

const DB = process.env.TEST_DATABASE_URL || 'postgres://postgres@localhost:5433/postly_test';
const cfg = { trustProxyHops: 0, sessionDays: 1, adminEmails: [], adminApiKey: '', anthropicApiKey: 'KEY', anthropicModel: 'claude-sonnet-5-5',
  whatsapp: {}, whatsappEnabled: false, webhookEnabled: false };

let pool, server, base, calls, script;
before(async () => {
  pool = createPool(DB);
  await migrate(pool, { retries: 2, delayMs: 200 });
  await pool.query('truncate users cascade');
  const llm = async (_u, opts) => { calls.push(JSON.parse(opts.body)); return new Response(JSON.stringify(script.shift()), { status: 200 }); };
  server = createApp(cfg, { pool, fetchImpl: llm, fetchPage: async () => '<title>Mine</title>We sell coffee beans in Beirut' }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

function client() {
  let cookie = '';
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(cookie && { cookie }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie?.() ?? []) cookie = c.split(';')[0];
    const text = await res.text(); let json; try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text };
  };
  return { get: (p) => call('GET', p), post: (p, b = {}) => call('POST', p, b), put: (p, b) => call('PUT', p, b), del: (p) => call('DELETE', p, {}) };
}
const signup = async (email) => { const c = client(); await c.post('/api/auth/register', { email, password: 'correct horse 1', businessName: 'Bean Co' }); return c; };
const tool = (platform) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_1', name: 'create_campaign_draft', input: { platform } }] });
const text = (t) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: t }] });

test('business profile stores market, price and differentiator; internal site text is never returned', async () => {
  const c = await signup('d1@z.com');
  const r = await c.put('/api/business', { country: 'Lebanon', price_range: '$$', usp: 'Roasted daily', description: 'Specialty coffee beans', website: 'beancoffee.example' });
  assert.equal(r.json.business.country, 'Lebanon');
  assert.equal(r.json.business.usp, 'Roasted daily');
  assert.ok(!('site_text' in r.json.business));
  assert.ok(!('site_signals' in r.json.business));
});

test('discover needs a description or website first', async () => {
  const c = await signup('d2@z.com');
  assert.equal((await c.post('/api/competitors/discover')).status, 400);
});

test('discover uses web search, continues on pause_turn, filters unsafe/duplicate results', async () => {
  const c = await signup('d3@z.com');
  await c.put('/api/business', { country: 'Lebanon', description: 'Specialty coffee beans', website: 'https://beancoffee.example', usp: 'Roasted daily' });
  calls = [];
  script = [
    { stop_reason: 'pause_turn', content: [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'coffee roasters Beirut' } }] },
    text('Here you go: [' + [
      '{"name":"Riverstone Cafe","url":"https://riverstone.example","why":"Roasts locally"}',
      '{"name":"Evil","url":"http://169.254.169.254/latest","why":"x"}',
      '{"name":"Me again","url":"https://www.beancoffee.example/shop","why":"same site as mine"}',
      '{"name":"Dup","url":"riverstone.example/about","why":"dup"}',
      '{"name":"Urban Roast","url":"urbanroast.example","why":"Online beans"}',
    ].join(',') + ']'),
  ];
  const r = await c.post('/api/competitors/discover');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.added.map((x) => x.name), ['Riverstone Cafe', 'Urban Roast']);
  assert.equal(r.json.added[0].source, 'ai');
  assert.equal(r.json.added[0].reason, 'Roasts locally');
  assert.equal(r.json.added[1].url, 'https://urbanroast.example');

  assert.equal(calls.length, 2);                                   // pause_turn -> second request
  assert.equal(calls[0].tools[0].type, 'web_search_20260209');
  assert.equal(calls[0].tools[0].name, 'web_search');
  assert.ok(calls[0].tools[0].max_uses <= 5);
  assert.ok(!calls[0].tools.some((t) => t.name === 'code_execution'));
  assert.equal(calls[1].messages.at(-1).role, 'assistant');        // prior turn echoed back
  assert.match(calls[0].system, /untrusted/i);
  assert.match(calls[0].messages[0].content, /Lebanon/);
  assert.match(calls[0].messages[0].content, /We sell coffee beans in Beirut/);   // own site text used

  // second discover adds nothing new (already tracked)
  await pool.query("update businesses set last_discovery_at = null where user_id = (select id from users where email='d3@z.com')");
  script = [text('[{"name":"Riverstone Cafe","url":"https://riverstone.example","why":"again"}]')];
  assert.deepEqual((await c.post('/api/competitors/discover')).json.added, []);
});

test('discover: bad model output and API failure are handled', async () => {
  const c = await signup('d4@z.com');
  await c.put('/api/business', { description: 'x shop' });
  script = [text('Sorry, I could not find any.')];
  assert.deepEqual((await c.post('/api/competitors/discover')).json.added, []);
  await pool.query("update businesses set last_discovery_at = null where user_id = (select id from users where email='d4@z.com')");
  const failing = createApp(cfg, { pool, fetchImpl: async () => new Response('{}', { status: 500 }) }).listen(0);
  const b2 = `http://127.0.0.1:${failing.address().port}`;
  const login = await fetch(b2 + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'd4@z.com', password: 'correct horse 1' }) });
  const cookie = login.headers.getSetCookie()[0].split(';')[0];
  const r = await fetch(b2 + '/api/competitors/discover', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{}' });
  assert.equal(r.status, 502);
  failing.close();
});

test('discover is disabled without an Anthropic key', async () => {
  const s = createApp({ ...cfg, anthropicApiKey: '' }, { pool }).listen(0);
  const b = `http://127.0.0.1:${s.address().port}`;
  const reg = await fetch(b + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'd5@z.com', password: 'correct horse 1' }) });
  const cookie = reg.headers.getSetCookie()[0].split(';')[0];
  const r = await fetch(b + '/api/competitors/discover', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{}' });
  assert.equal(r.status, 503);
  s.close();
});

test('several countries: normalised, capped at 6, searched per market, market saved on each competitor', async () => {
  const c = await signup('d6@z.com');
  const ok = await c.put('/api/business', { country: ' Lebanon | UAE |lebanon| Qatar ', description: 'Coffee beans' });
  assert.equal(ok.json.business.country, 'Lebanon | UAE | Qatar');
  assert.equal((await c.put('/api/business', { country: 'A|B|C|D|E|F|G' })).status, 400);
  assert.equal((await c.put('/api/business', { country: 'x'.repeat(60) })).status, 400);

  calls = [];
  script = [text('[{"name":"Lebanese Roast","url":"https://lroast.example","country":"Lebanon","why":"local"},{"name":"Dubai Beans","url":"https://dbeans.example","country":"UAE","why":"online"}]')];
  const r = await c.post('/api/competitors/discover');
  assert.deepEqual(r.json.added.map((x) => x.market), ['Lebanon', 'UAE']);
  assert.match(calls[0].system, /each market separately/i);
  assert.match(calls[0].messages[0].content, /Lebanon, UAE, Qatar/);
  assert.equal(calls[0].tools[0].max_uses, 5);   // 3 markets -> capped at 5 searches
  assert.equal((await c.get('/api/competitors')).json.competitors[0].market, 'Lebanon');
});

test('web search gives up before the proxy timeout instead of hanging', async () => {
  const { completeWithSearch } = await import('../src/llm.js');
  let n = 0;
  const slow = async () => { n++; return new Response(JSON.stringify({ stop_reason: 'pause_turn', content: [] }), { status: 200 }); };
  const t0 = Date.now();
  const out = await completeWithSearch({ cfg, system: 's', user: 'u', totalMs: 5100, fetchImpl: async (...a) => { await new Promise((r) => setTimeout(r, 200)); return slow(...a); } });
  assert.equal(out, null);
  assert.ok(Date.now() - t0 < 6000 && n >= 1);
});

test('JSON list is found even with prose, citations and code fences around it', async () => {
  const { extractJsonArray } = await import('../src/insights.js');
  const list = '[{"name":"A [x]","url":"https://a.example","why":"w"}]';
  assert.equal(extractJsonArray(`Here are the results [1][2]:\n\`\`\`json\n${list}\n\`\`\`\nSources: [1] foo, [2] bar`).length, 1);
  assert.equal(extractJsonArray(`Intro [Search results]. ${list} Thanks!`)[0].name, 'A [x]');
  assert.deepEqual(extractJsonArray('No competitors found [1].'), []);
  assert.deepEqual(extractJsonArray('[1, 2, 3]'), []);
});

test('discover reports how many candidates the AI returned', async () => {
  const c = await signup('d7@z.com');
  await c.put('/api/business', { description: 'wedding invites' });
  script = [text('Sorry [1] none.')];
  const r = await c.post('/api/competitors/discover');
  assert.deepEqual(r.json, { added: [], found: 0 });
});

test('discovery: once per 24h per user, failures give the slot back, operators are exempt', async () => {
  const c = await signup('lim@z.com');
  await c.put('/api/business', { description: 'shop' });
  script = [text('[{"name":"A","url":"https://a1.example","why":"w"}]')];
  assert.equal((await c.post('/api/competitors/discover')).status, 200);
  const again = await c.post('/api/competitors/discover');
  assert.equal(again.status, 429);
  assert.match(again.json.error, /once per day/i);
  assert.equal(calls.length > 0, true);

  // after 24h it works again
  await pool.query("update businesses set last_discovery_at = now() - interval '25 hours' where user_id=(select id from users where email='lim@z.com')");
  script = [text('[{"name":"B","url":"https://b1.example","why":"w"}]')];
  assert.equal((await c.post('/api/competitors/discover')).status, 200);

  // a failed AI call does not use up the day
  const f = await signup('lim2@z.com');
  await f.put('/api/business', { description: 'shop' });
  const failing = createApp(cfg, { pool, fetchImpl: async () => new Response('{}', { status: 500 }) }).listen(0);
  const fb = `http://127.0.0.1:${failing.address().port}`;
  const login = await fetch(fb + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'lim2@z.com', password: 'correct horse 1' }) });
  const cookie = login.headers.getSetCookie()[0].split(';')[0];
  const post = () => fetch(fb + '/api/competitors/discover', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{}' });
  assert.equal((await post()).status, 502);
  assert.equal((await post()).status, 502);   // not 429: the slot was refunded
  failing.close();

  // operators are exempt
  const op = createApp({ ...cfg, adminEmails: ['lim@z.com'] }, { pool, fetchImpl: async () => new Response(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: '[]' }] }), { status: 200 }) }).listen(0);
  const ob = `http://127.0.0.1:${op.address().port}`;
  const ol = await fetch(ob + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', }, body: JSON.stringify({ email: 'lim@z.com', password: 'correct horse 1' }) });
  const oc = ol.headers.getSetCookie()[0].split(';')[0];
  const opPost = () => fetch(ob + '/api/competitors/discover', { method: 'POST', headers: { 'content-type': 'application/json', cookie: oc }, body: '{}' });
  assert.equal((await opPost()).status, 200);
  assert.equal((await opPost()).status, 200);
  op.close();
});

test('cheaper search model uses the basic web search tool; newer models use dynamic filtering', async () => {
  const { completeWithSearch } = await import('../src/llm.js');
  const seen = [];
  const f = async (_u, o) => { seen.push(JSON.parse(o.body)); return new Response(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }), { status: 200 }); };
  await completeWithSearch({ cfg: { ...cfg, searchModel: 'claude-haiku-4-5' }, system: 's', user: 'u', fetchImpl: f });
  await completeWithSearch({ cfg: { ...cfg, searchModel: 'claude-opus-5-5' }, system: 's', user: 'u', fetchImpl: f });
  await completeWithSearch({ cfg: { ...cfg, searchModel: '' }, system: 's', user: 'u', fetchImpl: f });
  assert.deepEqual(seen.map((b) => [b.model, b.tools[0].type]), [
    ['claude-haiku-4-5', 'web_search_20250305'],
    ['claude-opus-5-5', 'web_search_20260209'],
    ['claude-sonnet-5-5', 'web_search_20260209'],
  ]);
});

test('chat gives the model the full business context and enough token budget', async () => {
  const c = await signup('ctx@z.com');
  await c.put('/api/business', { website: 'beancoffee.example', description: 'Specialty coffee beans', usp: 'Roasted daily', price_range: '$$', country: 'Lebanon | UAE', goal: 'Increase sales' });
  await c.post('/api/competitors', { name: 'Riverstone Cafe', url: 'riverstone.example' });
  script = [tool('Instagram'), text('{}'), text('Drafted.')];
  await c.post('/api/chat', { message: 'Create an Instagram campaign for me.' });
  calls = [];
  script = [text('Here is a plan.')];
  const r = await c.post('/api/chat', { message: 'I need more customers.' });
  assert.equal(r.json.reply, 'Here is a plan.');
  const body = calls[0];
  assert.match(body.system, /Text from their website[\s\S]*We sell coffee beans in Beirut/);   // read from the owner's own link
  assert.match(body.system, /Roasted daily/);
  assert.match(body.system, /Markets: Lebanon, UAE/);
  assert.match(body.system, /Riverstone Cafe/);                    // competitors
  assert.match(body.system, /Instagram, pending/);                 // campaigns
  assert.match(body.system, /untrusted/i);
  assert.ok(body.max_tokens >= 1500);                              // thinking tokens count against max_tokens
  assert.deepEqual(body.output_config, { effort: 'low' });
  assert.equal(body.messages.at(-1).content, 'I need more customers.');
});

test('effort is only sent to models that support it', async () => {
  const { complete } = await import('../src/llm.js');
  const seen = [];
  const f = async (_u, o) => { seen.push(JSON.parse(o.body)); return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), { status: 200 }); };
  await complete({ cfg: { ...cfg, anthropicModel: 'claude-haiku-4-5' }, system: 's', user: 'u', fetchImpl: f });
  await complete({ cfg: { ...cfg, anthropicModel: 'claude-sonnet-5-5' }, system: 's', user: 'u', fetchImpl: f });
  assert.equal(seen[0].output_config, undefined);
  assert.deepEqual(seen[1].output_config, { effort: 'low' });
  assert.ok(seen[1].max_tokens >= 1500);
});

test('asking twice for the same platform reuses the pending draft; drafts can be discarded, live ones cannot', async () => {
  const c = await signup('dup@z.com');
  script = [tool('Instagram'), text('{}'), text('Drafted.')];
  const a = await c.post('/api/chat', { message: 'Create an Instagram campaign for me.' });
  script = [tool('Instagram'), text('Already there.')];
  calls = [];
  const b = await c.post('/api/chat', { message: 'Create an Instagram campaign to compete with X.' });
  assert.equal(b.json.campaign.id, a.json.campaign.id);
  assert.equal((await c.get('/api/campaigns')).json.campaigns.length, 1);
  const toolResult = calls.at(-1).messages.at(-1).content[0];
  assert.equal(toolResult.type, 'tool_result');
  assert.match(toolResult.content, /already_exists/);

  script = [tool('Facebook'), text('{}'), text('ok')];
  await c.post('/api/chat', { message: 'Create a Facebook campaign for me.' });
  assert.equal((await c.get('/api/campaigns')).json.campaigns.length, 2);

  assert.equal((await c.del(`/api/campaigns/${a.json.campaign.id}`)).status, 200);
  assert.equal((await c.get('/api/campaigns')).json.campaigns.length, 1);
  const other = await signup('dup2@z.com');
  const fb = (await c.get('/api/campaigns')).json.campaigns[0];
  assert.equal((await other.del(`/api/campaigns/${fb.id}`)).status, 404);       // not yours
  await c.post(`/api/campaigns/${fb.id}/approve`);
  assert.equal((await c.del(`/api/campaigns/${fb.id}`)).status, 404);           // live: cannot discard
});


test('"3mele el ads campain lal meta": the model calls the tool, a real draft exists, and the reply matches reality', async () => {
  const c = await signup('meta@z.com');
  calls = [];
  script = [tool('Meta (Instagram + Facebook)'), text('{}'), text('Tamem, draft la Meta jehez bel Campaigns.')];
  const r = await c.post('/api/chat', { message: '3mele el ads campain lal meta' });
  assert.equal(r.json.campaign.platform, 'Instagram + Facebook');
  assert.equal(r.json.campaign.status, 'pending');
  assert.equal((await c.get('/api/campaigns')).json.campaigns.length, 1);
  // the model got tools and clear instructions to act first, in any language
  const first = calls[0];
  assert.equal(first.tools[0].name, 'create_campaign_draft');
  assert.ok(first.tools[0].input_schema.properties.platform.enum.includes('Meta (Instagram + Facebook)'));
  assert.match(first.system, /ACT, DO NOT INTERROGATE/);
  assert.match(first.system, /NEVER say a draft or campaign was created[\s\S]*unless create_campaign_draft returned/);
  // the tool result sent back to the model says what really happened
  const tr = calls.at(-1).messages.at(-1).content[0];
  assert.match(tr.content, /"status":"created"/);
});

test('if the model claims a draft without calling the tool, nothing is created and no campaign is returned', async () => {
  const c = await signup('claim@z.com');
  script = [text('Tamem, hayda draft campaign la Meta.')];
  const r = await c.post('/api/chat', { message: 'make me ads' });
  assert.equal(r.json.campaign, null);
  assert.deepEqual((await c.get('/api/campaigns')).json.campaigns, []);
});

test('unknown platform from the tool is reported back as an error, not turned into a draft', async () => {
  const c = await signup('snap@z.com');
  calls = [];
  script = [tool('Snapchat'), text('Which platform: Instagram, Facebook, Google, TikTok?')];
  const r = await c.post('/api/chat', { message: 'make a snapchat campaign' });
  assert.equal(r.json.campaign, null);
  const tr = calls.at(-1).messages.at(-1).content[0];
  assert.equal(tr.is_error, true);
  assert.deepEqual((await c.get('/api/campaigns')).json.campaigns, []);
});
