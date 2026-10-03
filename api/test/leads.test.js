import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createPool, migrate } from '../src/db.js';
import { scrubPII, scoreLead, sanitizeLead, sanitizeIcp, fallbackIcp } from '../src/leads.js';

const DB = process.env.TEST_DATABASE_URL || 'postgres://postgres@localhost:5433/postly_test';
const cfg = { trustProxyHops: 0, sessionDays: 1, adminEmails: ['boss@z.com'], adminApiKey: '', anthropicApiKey: 'KEY', anthropicModel: 'claude-sonnet-5-5', searchModel: 'claude-haiku-4-5',
  helpName: 'Hostbotics', helpUrl: 'https://hostbotics.net/', whatsapp: {}, whatsappEnabled: false, webhookEnabled: false };

let pool, server, url, script, calls, pages;
before(async () => {
  pool = createPool(DB);
  await migrate(pool, { retries: 2, delayMs: 200 });
  await pool.query('truncate users cascade');
  const llm = async (_u, o) => { calls.push(JSON.parse(o.body)); return new Response(JSON.stringify(script.shift() ?? { content: [{ type: 'text', text: 'ok' }] }), { status: 200 }); };
  const fetchPage = async (u) => {
    const r = pages[u] ?? '<html>ok</html>';
    if (r instanceof Error) throw r;
    return r;
  };
  server = createApp(cfg, { pool, fetchImpl: llm, fetchPage }).listen(0);
  url = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

function client() {
  let cookie = '';
  const call = async (method, path, body) => {
    const res = await fetch(url + path, { method, headers: { 'content-type': 'application/json', ...(cookie && { cookie }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie?.() ?? []) cookie = c.split(';')[0];
    const text = await res.text(); let json; try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text };
  };
  return { get: (p) => call('GET', p), post: (p, b = {}) => call('POST', p, b), put: (p, b) => call('PUT', p, b), patch: (p, b) => call('PATCH', p, b), del: (p) => call('DELETE', p, {}) };
}
const signup = async (email, profile = true) => {
  const c = client(); await c.post('/api/auth/register', { email, password: 'correct horse 1', businessName: 'Einvite' });
  if (profile) await c.put('/api/business', { description: 'Digital wedding invitations', country: 'Lebanon' });
  return c;
};
const txt = (t) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: t }] });
const lead = (o = {}) => ({ kind: 'business', name: 'Beirut Wedding Planners', url: 'https://bwp.example/', market: 'Lebanon', why: 'Plans weddings, sells no digital invites', evidence: 'Site lists print cards only',
  signals: { clear_need: true, local_match: true, active: true }, message: 'Hello! ... You can say no and I will not write again.', channel: 'Their contact page', ...o });

test('PII is stripped: emails, phone numbers and @handles', () => {
  const t = scrubPII('Write to ahmad@example.com or call +961 70 123 456 or DM @sara_k about it');
  assert.ok(!/ahmad@|961|123|sara_k/.test(t), t);
  assert.match(t, /\[removed\]/);
});

test('score comes from evidence flags; unverified links count for less', () => {
  assert.deepEqual(scoreLead('request', { explicit_request: true, timeframe: true, budget: true, local_match: true, active: true }, true), { score: 100, intent: 'high' });
  assert.equal(scoreLead('request', { explicit_request: true, timeframe: true, local_match: true }, true).intent, 'high');          // 75
  assert.equal(scoreLead('request', { explicit_request: true }, true).intent, 'medium');                                            // 40
  assert.equal(scoreLead('request', { active: true }, true).intent, 'low');                                                          // 10
  assert.equal(scoreLead('request', {}, true).score, 0);
  assert.equal(scoreLead('business', { clear_need: true, local_match: true, active: true }, true).intent, 'high');                 // 90
  assert.equal(scoreLead('business', { clear_need: true, local_match: true, active: true }, false).score, 72);                      // x0.8
  assert.equal(scoreLead('business', { clear_need: 'yes please' }, true).score, 0);                                                 // only literal true counts
});

test('sanitizeLead never names private individuals and rejects unsafe URLs', () => {
  const r = sanitizeLead({ kind: 'request', name: 'Maria Haddad', url: 'https://forum.example/t/abc', why: 'Email me at maria@x.com', evidence: 'call 70 123 456', signals: { explicit_request: true } });
  assert.equal(r.name, 'Public post on forum.example');
  assert.ok(!/maria|70 123/i.test(JSON.stringify(r)));
  assert.equal(sanitizeLead({ kind: 'business', name: 'X', url: 'http://169.254.169.254/' }), null);
  assert.equal(sanitizeLead({ kind: 'business', name: 'X', url: 'file:///etc/passwd' }), null);
  assert.equal(sanitizeLead({ kind: 'business', name: '', url: 'https://ok.example' }), null);
  assert.equal(sanitizeLead({ kind: 'business', name: 'Acme', url: 'acme.example' }).url, 'https://acme.example/');
});

test('customer profile: generated by the model or a plain fallback', async () => {
  assert.ok(sanitizeIcp({ segments: [{ name: 'A', where_to_find: ['x@y.com'] }] }).segments[0].where_to_find[0].includes('[removed]'));
  assert.ok(fallbackIcp({}).segments.length >= 1);
  const c = await signup('icp@z.com');
  calls = []; script = [txt(JSON.stringify({ summary: 'Couples and planners', segments: [{ name: 'Engaged couples', who: 'Getting married in 6 months', why_they_buy: 'Need invites', where_to_find: ['Wedding forums'] }], triggers: ['Set a date'], avoid: ['Browsers'] }))];
  const r = await c.post('/api/leads/profile');
  assert.equal(r.status, 200); assert.equal(r.json.icp_ai, true);
  assert.equal(r.json.icp.segments[0].name, 'Engaged couples');
  assert.match(calls[0].system, /never ways to obtain private contact data/);
  assert.equal((await c.get('/api/leads')).json.icp.summary, 'Couples and planners');
  script = [txt('nonsense')];
  assert.equal((await c.post('/api/leads/profile')).json.icp_ai, false);
  const noProfile = await signup('icp2@z.com', false);
  assert.equal((await noProfile.post('/api/leads/profile')).status, 400);
});

test('find: searches the web, verifies links, scores from evidence, drops dead links, dedupes, strips PII', async () => {
  const c = await signup('f1@z.com');
  pages = {
    'https://dead.example/': Object.assign(new Error('getaddrinfo ENOTFOUND dead.example'), { code: 'ENOTFOUND' }),
    'https://gone.example/': new Error('Site returned 404'),
    'https://blocked.example/': new Error('Site returned 403'),
  };
  calls = [];
  script = [txt('{"summary":"s","segments":[{"name":"Planners","who":"w","why_they_buy":"y","where_to_find":["Directories"]}],"triggers":[],"avoid":[]}'),
    txt('Results: ' + JSON.stringify([
      lead(),
      lead({ name: 'Dead Co', url: 'https://dead.example/' }),
      lead({ name: 'Gone Co', url: 'https://gone.example/' }),
      lead({ name: 'Blocked Co', url: 'https://blocked.example/' }),
      { kind: 'request', name: 'Maria H', url: 'https://forum.example/t/9', why: 'Wants invites. Mail maria@x.com', evidence: '"Looking for a digital wedding invitation designer, wedding in March, budget $100"', signals: { explicit_request: true, timeframe: true, budget: true, local_match: true, active: true }, message: 'Hi, ...', channel: 'Reply on the post' },
      lead({ name: 'Dup', url: 'https://bwp.example/' }),
      lead({ name: 'Owner', url: 'https://einvite.example/' }),
    ]))];
  await c.put('/api/business', { website: 'einvite.example' });
  const r = await c.post('/api/leads/find');
  assert.equal(r.status, 200);
  const names = r.json.added.map((x) => x.name).sort();
  assert.deepEqual(names, ['Beirut Wedding Planners', 'Blocked Co', 'Public post on forum.example']);
  const req = r.json.added.find((x) => x.kind === 'request');
  assert.equal(req.intent, 'high'); assert.equal(req.score, 100); assert.equal(req.verified, true);
  assert.ok(!/maria/i.test(JSON.stringify(req)));
  const blocked = r.json.added.find((x) => x.name === 'Blocked Co');
  assert.equal(blocked.verified, false);                       // kept, but marked as unverified
  assert.equal(blocked.score, 72);
  // the search itself: cheaper model, basic web search tool, strict rules in the prompt
  const search = calls.find((x) => x.tools?.[0]?.name === 'web_search');
  assert.equal(search.model, 'claude-haiku-4-5');
  assert.equal(search.tools[0].type, 'web_search_20250305');
  assert.match(search.system, /NEVER include emails, phone numbers/);
  assert.match(search.system, /Never invent a URL/);
  assert.match(search.system, /untrusted/i);
});

test('find: once per day, failures give the slot back, operators exempt, needs AI + a profile', async () => {
  const c = await signup('f2@z.com');
  script = [txt('{"summary":"s","segments":[{"name":"P"}]}'), txt(JSON.stringify([lead({ url: 'https://day1.example/' })]))];
  assert.equal((await c.post('/api/leads/find')).json.added.length, 1);
  const again = await c.post('/api/leads/find');
  assert.equal(again.status, 429); assert.match(again.json.error, /once per day/);

  const f = await signup('f3@z.com');
  const bad = createApp(cfg, { pool, fetchImpl: async () => new Response('{}', { status: 500 }) }).listen(0);
  const bu = `http://127.0.0.1:${bad.address().port}`;
  const lg = await fetch(bu + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'f3@z.com', password: 'correct horse 1' }) });
  const ck = lg.headers.getSetCookie()[0].split(';')[0];
  const post = () => fetch(bu + '/api/leads/find', { method: 'POST', headers: { 'content-type': 'application/json', cookie: ck }, body: '{}' });
  assert.equal((await post()).status, 502);
  assert.equal((await post()).status, 502);                    // not 429: slot refunded
  bad.close();

  const op = await signup('boss@z.com');
  script = [txt('{"summary":"s","segments":[{"name":"P"}]}'), txt('[]'), txt('[]')];
  assert.equal((await op.post('/api/leads/find')).status, 200);
  assert.equal((await op.post('/api/leads/find')).status, 200);

  const none = await signup('f4@z.com', false);
  assert.equal((await none.post('/api/leads/find')).status, 400);
  assert.equal((await client().post('/api/leads/find')).status, 401);
  const s2 = createApp({ ...cfg, anthropicApiKey: '' }, { pool }).listen(0);
  const r2 = await fetch(`http://127.0.0.1:${s2.address().port}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'f5@z.com', password: 'correct horse 1' }) });
  const c2 = r2.headers.getSetCookie()[0].split(';')[0];
  assert.equal((await fetch(`http://127.0.0.1:${s2.address().port}/api/leads/find`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: c2 }, body: '{}' })).status, 503);
  s2.close();
});

test('lead status, notes, delete and message rewrite are owner-only', async () => {
  const a = await signup('o1@z.com');
  script = [txt('{"summary":"s","segments":[{"name":"P"}]}'), txt(JSON.stringify([lead({ url: 'https://own1.example/' })]))];
  const found = await a.post('/api/leads/find');
  const id = found.json.added[0].id;
  assert.equal((await a.patch(`/api/leads/${id}`, { status: 'contacted', notes: 'Sent on Monday' })).json.lead.status, 'contacted');
  assert.equal((await a.patch(`/api/leads/${id}`, { status: 'bogus' })).status, 400);
  assert.equal((await a.patch(`/api/leads/${id}`, {})).status, 400);
  const b = await signup('o2@z.com');
  assert.equal((await b.patch(`/api/leads/${id}`, { status: 'won' })).status, 404);
  assert.equal((await b.post(`/api/leads/${id}/message`, { language: 'English' })).status, 404);
  assert.deepEqual((await b.get('/api/leads')).json.leads, []);

  calls = []; script = [txt('مرحبا، ... يمكنك قول لا ولن أكتب مجددا.')];
  const m = await a.post(`/api/leads/${id}/message`, { language: 'Arabic' });
  assert.match(m.json.lead.message, /مرحبا/);
  assert.match(calls[0].system, /Write it in Arabic/);
  assert.equal((await a.post(`/api/leads/${id}/message`, { language: 'Klingon' })).status, 400);

  await b.del(`/api/leads/${id}`);
  assert.equal((await a.get('/api/leads')).json.leads.length, 1);       // other user could not delete it
  await a.del(`/api/leads/${id}`);
  assert.equal((await a.get('/api/leads')).json.leads.length, 0);
});

test('the profile and internal fields are not leaked through /api/me', async () => {
  const c = await signup('me2@z.com');
  const me = (await c.get('/api/me')).json.business;
  for (const k of ['icp', 'icp_ai', 'last_prospect_at', 'site_text', 'site_signals']) assert.ok(!(k in me), k);
});

test('URL input: bare domains get https, every other scheme is rejected (not rewritten)', async () => {
  const { withHttps } = await import('../src/safefetch.js');
  assert.equal(withHttps('example.com/a'), 'https://example.com/a');
  assert.equal(withHttps('HTTP://example.com'), 'HTTP://example.com');
  for (const bad of ['file:///etc/passwd', 'ftp://x.com', 'javascript:alert(1)', 'data:text/html,hi', 'gopher://x']) assert.throws(() => withHttps(bad), /http/, bad);
  const c = await signup('url1@z.com');
  assert.equal((await c.post('/api/competitors', { name: 'X', url: 'file:///etc/passwd' })).status, 400);
  assert.equal((await c.post('/api/competitors', { name: 'X', url: 'javascript:alert(1)' })).status, 400);
  assert.equal((await c.post('/api/competitors', { name: 'X', url: 'riverstone.example' })).status, 201);
});

import { sanitizeTarget, matchMarket } from '../src/leads.js';

test('target: sanitised, scrubbed, limited; markets fall back to the business markets', () => {
  const t = sanitizeTarget({ customer_type: 'Individuals', segments: ['Engaged couples', 'mail me at a@b.com', 'x'.repeat(500), 'c', 'd', 'e'], countries: ['Lebanon', 'Lebanon', ' Qatar ', '', 'A', 'B', 'C', 'D', 'E'], notes: 'call 70 123 456' });
  assert.equal(t.customer_type, 'Individuals');
  assert.equal(t.segments.length, 4);
  assert.ok(t.segments.every((x) => x.length <= 160) && !/a@b\.com/.test(t.segments.join()));
  assert.deepEqual(t.countries.slice(0, 2), ['Lebanon', 'Qatar']);
  assert.equal(t.countries.length, 6);
  assert.ok(!/70 123/.test(t.notes));
  assert.equal(sanitizeTarget({ customer_type: 'Aliens' }).customer_type, '');
  assert.deepEqual(sanitizeTarget({}, ['Lebanon', 'UAE']).countries, ['Lebanon', 'UAE']);
  assert.equal(matchMarket('anything', ['Lebanon']), 'Lebanon');                       // single country is forced
  assert.equal(matchMarket('Beirut, Lebanon', ['Lebanon', 'Qatar']), 'Lebanon');
  assert.equal(matchMarket('qatar', ['Lebanon', 'Qatar']), 'Qatar');
  assert.equal(matchMarket('United States', ['Lebanon', 'Qatar']), null);
  assert.equal(matchMarket('', ['Lebanon', 'Qatar']), null);
});

test('find follows the target the owner chose: prompt, country filter, stored for next time', async () => {
  const c = await signup('tg1@z.com');
  await c.put('/api/business', { country: 'Lebanon | Qatar | United States' });      // business markets are wider than the target
  calls = []; pages = {};
  script = [txt('{"summary":"s","segments":[{"name":"P"}]}'), txt(JSON.stringify([
    lead({ name: 'Beirut Planner', url: 'https://t1.example/', market: 'Lebanon' }),
    lead({ name: 'Doha Planner', url: 'https://t2.example/', market: 'Qatar' }),
    lead({ name: 'Texas Planner', url: 'https://t3.example/', market: 'United States' }),
    lead({ name: 'No Market', url: 'https://t4.example/', market: '' }),
  ]))];
  const r = await c.post('/api/leads/find', { target: { customer_type: 'Businesses', segments: ['Wedding planners'], countries: ['Lebanon', 'Qatar'], notes: 'with a public contact form' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.added.map((x) => [x.name, x.market]).sort(), [['Beirut Planner', 'Lebanon'], ['Doha Planner', 'Qatar']]);   // US and market-less dropped
  const search = calls.find((x) => x.tools?.[0]?.name === 'web_search');
  assert.match(search.messages[0].content, /TARGET \(follow strictly\): customer type: Businesses; kinds of customers: Wedding planners; countries: Lebanon, Qatar; extra notes: with a public contact form/);
  assert.doesNotMatch(search.messages[0].content, /United States, /);
  assert.match(search.system, /only the customer type, kinds of customers and countries they chose/);
  assert.match(search.system, /"market" must be exactly one of the target countries/);
  assert.match(search.system, /Return \[\] only if your searches found nothing relevant at all/);
  const saved = (await c.get('/api/leads')).json.target;
  assert.deepEqual(saved.countries, ['Lebanon', 'Qatar']);
  assert.equal(saved.customer_type, 'Businesses');
  assert.ok(!('lead_target' in (await c.get('/api/me')).json.business));
});

test('find: a search that delivers nothing does not use up the day; no country at all is refused', async () => {
  const c = await signup('tg2@z.com');
  script = [txt('{"summary":"s","segments":[{"name":"P"}]}'), txt('Nothing relevant.'), txt('[]')];
  const a = await c.post('/api/leads/find');
  assert.equal(a.status, 200); assert.equal(a.json.added.length, 0);
  assert.equal((await c.post('/api/leads/find')).status, 200);                       // not 429: nothing was delivered
  const none = await signup('tg3@z.com', false);
  await none.put('/api/business', { description: 'wedding invites' });                // no country anywhere
  const r = await none.post('/api/leads/find', { target: { countries: [] } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /at least one country/);
});
