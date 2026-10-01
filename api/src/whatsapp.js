import crypto from 'node:crypto';

const E164 = /^\d{8,15}$/; // digits only, no "+", as the Cloud API expects
const TEMPLATE_NAME = /^[a-z0-9_]{1,512}$/;
const LANG = /^[a-z]{2}(_[A-Z]{2})?$/;

export class ValidationError extends Error {}

export function normalizePhone(input) {
  const digits = String(input ?? '').replace(/[\s()+-]/g, '');
  if (!E164.test(digits)) throw new ValidationError('Invalid phone number (use international format)');
  return digits;
}

export function validateText(body) {
  if (typeof body !== 'string' || body.trim() === '' || body.length > 4096) {
    throw new ValidationError('Message body must be 1-4096 characters');
  }
  return body;
}

export function validateTemplate({ name, language = 'en_US', params = [] }) {
  if (!TEMPLATE_NAME.test(String(name))) throw new ValidationError('Invalid template name');
  if (!LANG.test(language)) throw new ValidationError('Invalid language code');
  if (!Array.isArray(params) || params.length > 20 || params.some((p) => typeof p !== 'string' || p.length > 1024)) {
    throw new ValidationError('Invalid template params');
  }
  return { name, language, params };
}

export function verifySignature(rawBody, header, appSecret) {
  if (!header || !header.startsWith('sha256=') || !Buffer.isBuffer(rawBody)) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest();
  let given;
  try { given = Buffer.from(header.slice(7), 'hex'); } catch { return false; }
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

export function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function createWhatsAppClient(cfg, fetchImpl = fetch) {
  const url = `https://graph.facebook.com/${cfg.graphVersion}/${cfg.phoneNumberId}/messages`;

  async function post(payload) {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Log Meta's error server-side; never forward upstream details or headers to callers.
      const err = new Error('WhatsApp API request failed');
      err.upstreamStatus = res.status;
      err.upstreamCode = data?.error?.code;
      err.upstreamMessage = data?.error?.message;
      throw err;
    }
    return { messageId: data?.messages?.[0]?.id ?? null };
  }

  return {
    sendText: (to, body) =>
      post({ to: normalizePhone(to), type: 'text', text: { body: validateText(body), preview_url: false } }),
    sendTemplate: (to, tpl) => {
      const { name, language, params } = validateTemplate(tpl);
      return post({
        to: normalizePhone(to),
        type: 'template',
        template: {
          name,
          language: { code: language },
          ...(params.length && {
            components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }],
          }),
        },
      });
    },
  };
}
