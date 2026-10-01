import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createApp } from '../src/app.js';
import { createWhatsAppClient } from '../src/whatsapp.js';
import { createPool, migrate } from '../src/db.js';

const DB = process.env.TEST_DATABASE_URL || 'postgres://postgres@localhost:5433/postly_test';
const cfg = {
  trustProxyHops: 0, sessionDays: 1, adminEmails: ['boss@x.com'], adminApiKey: 'k',
  anthropicApiKey: '', anthropicModel: 'm',
  whatsapp: { accessToken: 'SECRET_TOKEN_123', phoneNumberId: '111', verifyToken: 'vt', appSecret: 'as', graphVersion: 'v21.0' },
  whatsappEnabled: true, webhookEnabled: true,
};

let pool, server, base, waFetch;
before(async () => {
  pool = createPool(DB);
  await migrate(pool, { retries: 2, delayMs: 200 });
  await pool.query('truncate users cascade');
  const wa = createWhatsAppClient(cfg.whatsapp, (...a) => waFetch(...a));
  server = createApp(cfg, { pool, wa }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

// minimal cookie-jar client
function client() {
  let cookie = '';
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie && { cookie }), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const sc = res.headers.getSetCookie?.() ?? [];
    for (const c of sc) cookie = c.startsWith('postly_sid=;') || /Max-Age=0/.test(c) ? '' : c.split(';')[0];
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, setCookie: sc };
  };
  return { get: (p) => call('GET', p), post: (p, b = {}, h) => call('POST', p, b, h), put: (p, b) => call('PUT', p, b), call };
}
const reg = (c, email, extra = {}) =>
  c.post('/api/auth/register', { email, password: 'correct horse 1', firstName: 'A', businessName: 'Riverside Coffee', ...extra });

test('register sets an HttpOnly session cookie and /me works', async () => {
  const c = client();
  const r = await reg(c, 'a@x.com');
  assert.equal(r.status, 201);
  assert.match(r.setCookie[0], /HttpOnly/);
  assert.match(r.setCookie[0], /SameSite=Lax/);
  assert.ok(!r.text.includes('password'));
  const me = await c.get('/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.user.email, 'a@x.com');
  assert.equal(me.json.business.name, 'Riverside Coffee');
});

test('register validates input and rejects duplicates', async () => {
  const c = client();
  assert.equal((await reg(c, 'not-an-email')).status, 400);
  assert.equal((await c.post('/api/auth/register', { email: 'b@x.com', password: 'short' })).status, 400);
  assert.equal((await reg(c, 'dup@x.com')).status, 201);
  assert.equal((await reg(client(), 'DUP@x.com')).status, 409);
});

test('login / logout', async () => {
  await reg(client(), 'l@x.com');
  const c = client();
  assert.equal((await c.post('/api/auth/login', { email: 'l@x.com', password: 'wrong password' })).status, 401);
  assert.equal((await c.post('/api/auth/login', { email: 'nobody@x.com', password: 'whatever123' })).status, 401);
  assert.equal((await c.get('/api/me')).status, 401);
  assert.equal((await c.post('/api/auth/login', { email: 'l@x.com', password: 'correct horse 1' })).status, 200);
  assert.equal((await c.get('/api/me')).status, 200);
  await c.post('/api/auth/logout');
  assert.equal((await c.get('/api/me')).status, 401);
});

test('password is stored hashed, session token is stored hashed', async () => {
  const { rows } = await pool.query("select password_hash from users where email='l@x.com'");
  assert.match(rows[0].password_hash, /^scrypt\$/);
  assert.ok(!rows[0].password_hash.includes('correct horse'));
});

test('CSRF guard: foreign origin and non-JSON are rejected', async () => {
  const c = client();
  await reg(c, 'csrf@x.com');
  assert.equal((await c.post('/api/chat', { message: 'hi' }, { origin: 'https://evil.example' })).status, 403);
  const form = await fetch(base + '/api/auth/logout', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=b' });
  assert.equal(form.status, 415);
});

test('protected routes need a session', async () => {
  const c = client();
  for (const p of ['/api/campaigns', '/api/dashboard', '/api/chat', '/api/channels']) {
    assert.equal((await c.get(p)).status, 401, p);
  }
});

test('onboarding saves the business profile', async () => {
  const c = client();
  await reg(c, 'biz@x.com');
  const r = await c.put('/api/business', { industry: 'Food & beverage', goal: 'Get more customers', budget: '$100 – $300', onboarded: true });
  assert.equal(r.status, 200);
  assert.equal(r.json.business.goal, 'Get more customers');
  assert.equal(r.json.business.onboarded, true);
  assert.equal((await c.put('/api/business', { name: 'x'.repeat(500) })).status, 400);
});

test('chat drafts a campaign, approval makes it live, data is per-user', async () => {
  const a = client(); const b = client();
  await reg(a, 'ca@x.com'); await reg(b, 'cb@x.com');
  const chat = await a.post('/api/chat', { message: 'Create an Instagram campaign for me.' });
  assert.equal(chat.status, 200);
  assert.equal(chat.json.campaign.platform, 'Instagram');
  assert.equal(chat.json.campaign.status, 'pending');
  const id = chat.json.campaign.id;

  assert.equal((await b.post(`/api/campaigns/${id}/approve`)).status, 404); // other user
  assert.deepEqual((await b.get('/api/campaigns')).json.campaigns, []);

  assert.equal((await a.post(`/api/campaigns/${id}/approve`)).json.campaign.status, 'live');
  assert.equal((await a.post(`/api/campaigns/${id}/approve`)).status, 404); // already live

  const d = (await a.get('/api/dashboard')).json;
  assert.equal(d.live, 1); assert.equal(d.pending, 0); assert.equal(d.daily_spend, 20);
  assert.ok(d.activity.length >= 2);
  const history = (await a.get('/api/chat')).json.messages;
  assert.equal(history.length, 2);
});

test('channels connect / disconnect', async () => {
  const c = client();
  await reg(c, 'ch@x.com');
  await c.put('/api/channels/Instagram', { accountLabel: '@shop' });
  assert.equal((await c.get('/api/channels')).json.channels[0].account_label, '@shop');
  assert.equal((await c.put('/api/channels/Nope', {})).status, 400);
  await c.put('/api/channels/Instagram', { connected: false });
  assert.equal((await c.get('/api/channels')).json.channels.length, 0);
});

test('WhatsApp: normal users are blocked, operator can send, token never leaks', async () => {
  let seen;
  waFetch = async (url, opts) => { seen = { url, opts }; return new Response(JSON.stringify({ messages: [{ id: 'wamid.1' }] }), { status: 200 }); };
  const user = client(); await reg(user, 'plain@x.com');
  assert.equal((await user.post('/api/whatsapp/send', { to: '96170000000', body: 'hi' })).status, 403);
  assert.equal((await client().post('/api/whatsapp/send', { to: '96170000000', body: 'hi' })).status, 401);

  const boss = client(); await reg(boss, 'boss@x.com');
  assert.equal((await boss.get('/api/me')).json.user.canSendWhatsApp, true);
  const r = await boss.post('/api/whatsapp/send', { to: '+961 70 000 000', body: 'hi' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { messageId: 'wamid.1' });
  assert.equal(seen.opts.headers.Authorization, 'Bearer SECRET_TOKEN_123');
  assert.ok(!r.text.includes('SECRET_TOKEN_123'));

  assert.equal((await client().post('/api/whatsapp/send', { to: '96170000000', body: 'hi' }, { 'x-api-key': 'k' })).status, 200);
  assert.equal((await boss.post('/api/whatsapp/send', { to: 'abc', body: 'hi' })).status, 400);

  waFetch = async () => new Response(JSON.stringify({ error: { message: 'Bearer SECRET_TOKEN_123 bad', code: 190 } }), { status: 401 });
  const bad = await boss.post('/api/whatsapp/send', { to: '96170000000', body: 'hi' });
  assert.equal(bad.status, 502);
  assert.ok(!bad.text.includes('SECRET'));
});

test('webhook handshake and HMAC signature', async () => {
  const ok = await fetch(`${base}/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=42`);
  assert.equal(await ok.text(), '42');
  assert.equal((await fetch(`${base}/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=no&hub.challenge=42`)).status, 403);
  const body = JSON.stringify({ entry: [] });
  const sig = 'sha256=' + crypto.createHmac('sha256', 'as').update(body).digest('hex');
  const post = (h) => fetch(`${base}/api/whatsapp/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body });
  assert.equal((await post({ 'x-hub-signature-256': sig })).status, 200);
  assert.equal((await post({ 'x-hub-signature-256': 'sha256=00' })).status, 401);
  assert.equal((await post({})).status, 401);
});

test('without an AI key, the rule-based fallback understands Arabic-in-Latin requests too', async () => {
  const c = client();
  await reg(c, 'franco@x.com');
  for (const [msg, platform] of [['3mele el ads campain lal meta', 'Instagram + Facebook'], ['sawwi campaign instagram', 'Instagram'], ['esna3 e3lan 3ala google', 'Google']]) {
    const r = await c.post('/api/chat', { message: msg });
    assert.equal(r.json.campaign?.platform, platform, msg);
  }
  assert.equal((await c.post('/api/chat', { message: 'hello there' })).json.campaign, null);
});
