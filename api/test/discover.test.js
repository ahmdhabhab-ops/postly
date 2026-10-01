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
  return { get: (p) => call('GET', p), post: (p, b = {}) => call('POST', p, b), put: (p, b) => call('PUT', p, b) };
}
const signup = async (email) => { const c = client(); await c.post('/api/auth/register', { email, password: 'correct horse 1', businessName: 'Bean Co' }); return c; };
const text = (t) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: t }] });

test('business profile stores market, price and differentiator; internal site text is never returned', async () => {
  const c = await signup('d1@z.com');
  const r = await c.put('/api/business', { country: 'Lebanon', price_range: '$$', usp: 'Roasted daily', description: 'Specialty coffee beans', website: 'beancoffee.example' });
  assert.equal(r.json.business.country, 'Lebanon');
  assert.equal(r.json.business.usp, 'Roasted daily');
  assert.ok(!('site_text' in r.json.business));
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
  script = [text('[{"name":"Riverstone Cafe","url":"https://riverstone.example","why":"again"}]')];
  assert.deepEqual((await c.post('/api/competitors/discover')).json.added, []);
});

test('discover: bad model output and API failure are handled', async () => {
  const c = await signup('d4@z.com');
  await c.put('/api/business', { description: 'x shop' });
  script = [text('Sorry, I could not find any.')];
  assert.deepEqual((await c.post('/api/competitors/discover')).json.added, []);
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
  assert.ok(calls[0].tools[0].max_uses >= 8 || calls[0].tools[0].max_uses === Math.min(8, 3 + 3 * 2));
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
