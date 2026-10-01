import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createApp } from '../src/app.js';
import { createWhatsAppClient } from '../src/whatsapp.js';

const cfg = {
  graphVersion: 'v21.0', accessToken: 'SECRET_TOKEN_123', phoneNumberId: '111',
  verifyToken: 'vt', appSecret: 'as', adminApiKey: 'k', corsOrigin: '',
};

async function start(fetchImpl) {
  const wa = createWhatsAppClient(cfg, fetchImpl);
  const events = [];
  const server = createApp(cfg, { wa, onEvent: (e) => events.push(e) }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, events, close: () => server.close() };
}
const post = (url, body, headers = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('send requires api key', async () => {
  const s = await start(); 
  assert.equal((await post(`${s.base}/api/whatsapp/send`, { to: '96170000000', body: 'hi' })).status, 401);
  s.close();
});

test('send calls Meta with server-side token and never leaks it', async () => {
  let seen;
  const s = await start(async (url, opts) => {
    seen = { url, opts };
    return new Response(JSON.stringify({ messages: [{ id: 'wamid.1' }] }), { status: 200 });
  });
  const r = await post(`${s.base}/api/whatsapp/send`, { to: '+961 70 000 000', body: 'hi' }, { 'x-api-key': 'k' });
  const text = await r.text();
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(text), { messageId: 'wamid.1' });
  assert.equal(seen.opts.headers.Authorization, 'Bearer SECRET_TOKEN_123');
  assert.equal(JSON.parse(seen.opts.body).to, '96170000000');
  assert.ok(!text.includes('SECRET_TOKEN_123'));
  s.close();
});

test('upstream errors are sanitized', async () => {
  const s = await start(async () => new Response(JSON.stringify({ error: { message: 'Bearer SECRET_TOKEN_123 bad', code: 190 } }), { status: 401 }));
  const r = await post(`${s.base}/api/whatsapp/send`, { to: '96170000000', body: 'hi' }, { 'x-api-key': 'k' });
  const text = await r.text();
  assert.equal(r.status, 502);
  assert.ok(!text.includes('SECRET'));
  s.close();
});

test('validation rejects bad phone', async () => {
  const s = await start();
  const r = await post(`${s.base}/api/whatsapp/send`, { to: 'abc', body: 'hi' }, { 'x-api-key': 'k' });
  assert.equal(r.status, 400);
  s.close();
});

test('webhook verification handshake', async () => {
  const s = await start();
  const ok = await fetch(`${s.base}/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=42`);
  assert.equal(await ok.text(), '42');
  const bad = await fetch(`${s.base}/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42`);
  assert.equal(bad.status, 403);
  s.close();
});

test('webhook POST needs valid HMAC signature', async () => {
  const s = await start();
  const body = JSON.stringify({ entry: [] });
  const sig = 'sha256=' + crypto.createHmac('sha256', 'as').update(body).digest('hex');
  assert.equal((await post(`${s.base}/api/whatsapp/webhook`, body, { 'x-hub-signature-256': sig })).status, 200);
  assert.equal((await post(`${s.base}/api/whatsapp/webhook`, body, { 'x-hub-signature-256': 'sha256=00' })).status, 401);
  assert.equal((await post(`${s.base}/api/whatsapp/webhook`, body)).status, 401);
  s.close();
});
