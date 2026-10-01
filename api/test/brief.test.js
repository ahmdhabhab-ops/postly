import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createPool, migrate } from '../src/db.js';
import { siteSignals, websiteNotes, sanitizeBrief, fallbackBrief, generateBrief, classifyFetchError } from '../src/brief.js';

const DB = process.env.TEST_DATABASE_URL || 'postgres://postgres@localhost:5433/postly_test';
const base = { trustProxyHops: 0, sessionDays: 1, adminEmails: [], adminApiKey: '', anthropicApiKey: 'KEY', anthropicModel: 'claude-sonnet-5-5',
  helpName: 'Hostbotics', helpUrl: 'https://hostbotics.net/', whatsapp: {}, whatsappEnabled: false, webhookEnabled: false };

const GOOD = {
  objective: 'Get more wedding invitation orders',
  audience: { age_min: 24, age_max: 38, genders: 'All', locations: ['Lebanon'], interests: ['Weddings', 'Engagement', 'Event planning'], notes: 'n' },
  placements: ['Instagram Feed', 'Stories', 'Reels'],
  creative: { formats: ['Reel 15s'], ideas: ['Show an invite being personalised'] },
  copy: { headline: 'Your wedding invite in minutes', primary_text: 'Design, share, track RSVPs.', cta: 'Learn more' },
  landing: 'https://einvite.example', kpis: ['Cost per lead'],
  assumptions: ['Suggested by AI: women 24-38 are the main buyers'], questions: ['Do you offer a free preview?'],
};

let pool, server, url, script, calls, pageHtml;
before(async () => {
  pool = createPool(DB);
  await migrate(pool, { retries: 2, delayMs: 200 });
  await pool.query('truncate users cascade');
  const llm = async (_u, o) => { calls.push(JSON.parse(o.body)); return new Response(JSON.stringify(script.shift() ?? { content: [{ type: 'text', text: 'ok' }] }), { status: 200 }); };
  server = createApp(base, { pool, fetchImpl: llm, fetchPage: async () => pageHtml }).listen(0);
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
  return { get: (p) => call('GET', p), post: (p, b = {}) => call('POST', p, b), put: (p, b) => call('PUT', p, b) };
}
const signup = async (email) => { const c = client(); await c.post('/api/auth/register', { email, password: 'correct horse 1', businessName: 'Einvite' }); return c; };
const txt = (t) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: t }] });

test('siteSignals reads what ads need from the page HTML', () => {
  const good = siteSignals('<html><head><meta name="viewport" content="width=device-width"><script>fbq("init","1")</script></head><body><a href="https://wa.me/961">chat</a>' + 'x '.repeat(400) + '</body></html>', 'https://a.example');
  assert.deepEqual([good.https, good.pixel, good.whatsapp, good.contact, good.viewport], [true, true, true, true, true]);
  const bad = siteSignals('<html><body>hello</body></html>', 'http://a.example');
  assert.deepEqual([bad.https, bad.pixel, bad.contact, bad.viewport], [false, false, false, false]);
});

test('website notes: deterministic, name the partner, depend on platform', () => {
  const cfg = base;
  const none = websiteNotes({ business: { website: '' }, signals: null, cfg });
  assert.match(none[0], /do not have a website yet/);
  assert.match(none[0], /Hostbotics \(https:\/\/hostbotics\.net\/\) can help/);
  const n = (signals) => websiteNotes({ business: { website: 'x.com' }, signals, cfg }).join(' ');
  assert.match(n({ ok: false, reason: 'dns' }), /could not find your website address[\s\S]*Hostbotics/);
  assert.match(n({ ok: false, reason: 'timeout' }), /did not answer in time/);
  // blocked / unknown: never claim the site is down, never push the partner
  for (const reason of ['blocked', 'other', undefined]) {
    const t = n({ ok: false, reason });
    assert.match(t, /does not mean it is down/);
    assert.ok(!/Hostbotics/.test(t));
  }
  assert.deepEqual(websiteNotes({ business: { website: 'x.com' }, signals: null, cfg }), []);
  const spa = siteSignals('<html><body><div id="root"></div></body></html>', 'https://x.com');
  assert.equal(spa.spa, true);
  const spaNote = n({ ...spa, ok: true });
  assert.match(spaNote, /loads its content with JavaScript/);
  assert.ok(!/Meta Pixel found/.test(spaNote) && !/very little content/.test(spaNote));
  const sig = { ok: true, https: true, pixel: false, contact: true, viewport: true, textLen: 900 };
  assert.match(websiteNotes({ business: { website: 'x.com' }, signals: sig, cfg, platform: 'Instagram' }).join(' '), /Meta Pixel/);
  assert.deepEqual(websiteNotes({ business: { website: 'x.com' }, signals: sig, cfg, platform: 'Google' }), []);   // pixel only matters for Meta
  assert.deepEqual(websiteNotes({ business: { website: 'x.com' }, signals: { ...sig, pixel: true }, cfg, platform: 'Instagram' }), []);
});

test('fetch errors are classified without blaming the site', () => {
  assert.equal(classifyFetchError(new Error('Site returned 403')), 'blocked');
  assert.equal(classifyFetchError(new Error('Not an HTML page')), 'blocked');
  assert.equal(classifyFetchError(new Error('Site returned 503')), 'error');
  assert.equal(classifyFetchError(Object.assign(new Error('getaddrinfo ENOTFOUND x'), { code: 'ENOTFOUND' })), 'dns');
  assert.equal(classifyFetchError(new Error('Site took too long to respond')), 'timeout');
  assert.equal(classifyFetchError(new Error('???')), 'other');
});

test('sanitizeBrief clamps ages, trims and drops junk', () => {
  const b = sanitizeBrief({ objective: 'x'.repeat(999), audience: { age_min: 5, age_max: 200, interests: ['a', 3, null, 'b'] }, placements: 'nope', copy: { headline: 7 } });
  assert.equal(b.objective.length, 200);
  assert.equal(b.audience.age_min, 13); assert.equal(b.audience.age_max, 65);
  assert.deepEqual(b.audience.interests, ['a', 'b']);
  assert.deepEqual(b.placements, []);
  assert.equal(b.copy.headline, '');
  assert.ok(sanitizeBrief(null).audience);
});

test('fallback brief is built from the profile and asks what is missing', () => {
  const b = fallbackBrief({ business: { goal: 'Get more customers', customer_age: '25–34', country: 'Lebanon | UAE', interests: 'weddings, events' }, campaign: { platform: 'Instagram' } });
  assert.equal(b.audience.age_min, 25); assert.equal(b.audience.age_max, 34);
  assert.deepEqual(b.audience.locations, ['Lebanon', 'UAE']);
  assert.deepEqual(b.audience.interests, ['weddings', 'events']);
  assert.ok(b.questions.some((q) => /different/i.test(q)));
});

test('generateBrief asks the model for JSON, flags assumptions, and falls back on junk output', async () => {
  const cfg = { ...base };
  calls = []; script = [txt('Sure! ```json\n' + JSON.stringify(GOOD) + '\n```')];
  const ok = await generateBrief({ cfg, business: { name: 'Einvite', goal: 'Increase sales' }, campaign: { title: 't', platform: 'Instagram', budget_per_day: 20, duration_days: 7 }, fetchImpl: async (_u, o) => { calls.push(JSON.parse(o.body)); return new Response(JSON.stringify(script.shift()), { status: 200 }); } });
  assert.equal(ok.ai, true);
  assert.deepEqual(ok.brief.audience.interests, ['Weddings', 'Engagement', 'Event planning']);
  assert.match(calls[0].system, /Suggested by AI:/);
  assert.match(calls[0].system, /untrusted/i);
  const junk = await generateBrief({ cfg, business: {}, campaign: { title: 't', platform: 'Instagram', budget_per_day: 20, duration_days: 7 }, fetchImpl: async () => new Response(JSON.stringify(txt('I cannot help')), { status: 200 }) });
  assert.equal(junk.ai, false);
  assert.ok(junk.brief.audience.age_min >= 13);
});

test('chat creates a campaign with a full brief and the website check; plan can be regenerated; per-user', async () => {
  const c = await signup('b1@z.com');
  pageHtml = '<html><body>Wedding invites. We are small.</body></html>';          // no https meta/viewport/pixel/contact
  await c.put('/api/business', { website: 'einvite.example', description: 'Digital wedding invitations', country: 'Lebanon', usp: 'Mobile friendly' });
  calls = []; script = [txt(JSON.stringify(GOOD)), txt('Done, see the plan.')];
  const r = await c.post('/api/chat', { message: 'Create an Instagram campaign for me.' });
  assert.equal(r.status, 200);
  const camp = r.json.campaign;
  assert.equal(camp.brief.audience.interests[0], 'Weddings');
  assert.equal(camp.brief.questions[0], 'Do you offer a free preview?');
  assert.ok(camp.website_notes.some((n) => /Meta Pixel/.test(n) && /Hostbotics/.test(n)));
  assert.ok(camp.website_notes.some((n) => /mobile/i.test(n)));
  // the chat model was told about the problems and the partner
  const chatBody = calls.at(-1);
  assert.match(chatBody.system, /Website problems found automatically[\s\S]*Meta Pixel/);
  assert.match(chatBody.system, /Hostbotics \(https:\/\/hostbotics\.net\/\) can help/);

  const list = (await c.get('/api/campaigns')).json.campaigns[0];
  assert.equal(list.brief.copy.headline, 'Your wedding invite in minutes');

  // regenerate the plan
  script = [txt(JSON.stringify({ ...GOOD, objective: 'New objective' }))];
  const pl = await c.post(`/api/campaigns/${camp.id}/plan`);
  assert.equal(pl.json.campaign.brief.objective, 'New objective');
  assert.equal((await signup('b2@z.com').then((o) => o.post(`/api/campaigns/${camp.id}/plan`))).status, 404);
});

test('with no website at all, the client is told and pointed to the partner', async () => {
  const c = await signup('b3@z.com');
  script = [];
  const r = await c.post('/api/chat', { message: 'Create a Facebook campaign for me.' });
  assert.match(r.json.campaign.website_notes[0], /do not have a website yet/);
  assert.match(r.json.campaign.website_notes[0], /hostbotics\.net/);
});

test('/api/me tells the client which partner to link to', async () => {
  const c = await signup('help@z.com');
  const me = await c.get('/api/me');
  assert.deepEqual(me.json.help, { name: 'Hostbotics', url: 'https://hostbotics.net/' });
});

test('change password: needs the current one, signs out other devices, old password stops working', async () => {
  const a = await signup('pw@z.com');
  const b = client();
  await b.post('/api/auth/login', { email: 'pw@z.com', password: 'correct horse 1' });      // second device
  assert.equal((await b.get('/api/me')).status, 200);
  assert.equal((await a.post('/api/auth/password', { current: 'wrong wrong 1', next: 'brand new pass 2' })).status, 401);
  assert.equal((await a.post('/api/auth/password', { current: 'correct horse 1', next: 'short' })).status, 400);
  assert.equal((await a.post('/api/auth/password', { current: 'correct horse 1', next: 'brand new pass 2' })).status, 200);
  assert.equal((await a.get('/api/me')).status, 200);        // this device stays signed in
  assert.equal((await b.get('/api/me')).status, 401);        // the other one is signed out
  assert.equal((await client().post('/api/auth/login', { email: 'pw@z.com', password: 'correct horse 1' })).status, 401);
  assert.equal((await client().post('/api/auth/login', { email: 'pw@z.com', password: 'brand new pass 2' })).status, 200);
  assert.equal((await client().post('/api/auth/password', { current: 'x', next: 'y' })).status, 401);
});
