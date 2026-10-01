import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import {
  ValidationError, createWhatsAppClient, safeEqual, verifySignature,
} from './whatsapp.js';

export function createApp(cfg, { wa = createWhatsAppClient(cfg), onEvent = defaultOnEvent } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind the nginx container
  app.use(helmet());

  if (cfg.corsOrigin) {
    app.use((req, res, next) => {
      if (req.headers.origin === cfg.corsOrigin) {
        res.setHeader('Access-Control-Allow-Origin', cfg.corsOrigin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      }
      if (req.method === 'OPTIONS') return res.sendStatus(204);
      next();
    });
  }

  app.get('/healthz', (_req, res) => res.type('text/plain').send('ok'));

  // --- Webhook (called by Meta). Raw body is needed to check the HMAC signature. ---
  app.get('/api/whatsapp/webhook', (req, res) => {
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
    if (mode === 'subscribe' && typeof token === 'string' && safeEqual(token, cfg.verifyToken)) {
      return res.status(200).type('text/plain').send(String(challenge ?? ''));
    }
    res.sendStatus(403);
  });

  app.post(
    '/api/whatsapp/webhook',
    express.raw({ type: 'application/json', limit: '1mb' }),
    (req, res) => {
      if (!verifySignature(req.body, req.get('x-hub-signature-256'), cfg.appSecret)) {
        return res.sendStatus(401);
      }
      let payload;
      try { payload = JSON.parse(req.body.toString('utf8')); } catch { return res.sendStatus(400); }
      res.sendStatus(200); // ack fast; Meta retries on slow/non-2xx responses
      try { onEvent(payload); } catch (e) { console.error('webhook handler error:', e.message); }
    },
  );

  // --- Send endpoints: protected by a server-side key, never by anything in the browser bundle. ---
  const sendLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });
  const requireKey = (req, res, next) => {
    const key = req.get('x-api-key');
    if (!key || !safeEqual(key, cfg.adminApiKey)) return res.status(401).json({ error: 'Unauthorized' });
    next();
  };
  const json = express.json({ limit: '16kb' });

  const handle = (fn) => async (req, res) => {
    try {
      res.json(await fn(req.body ?? {}));
    } catch (e) {
      if (e instanceof ValidationError) return res.status(400).json({ error: e.message });
      console.error('whatsapp send failed:', e.upstreamStatus, e.upstreamCode, e.upstreamMessage ?? e.message);
      res.status(502).json({ error: 'Could not send WhatsApp message' });
    }
  };

  app.post('/api/whatsapp/send', sendLimiter, requireKey, json, handle((b) => wa.sendText(b.to, b.body)));
  app.post('/api/whatsapp/send-template', sendLimiter, requireKey, json, handle((b) =>
    wa.sendTemplate(b.to, { name: b.name, language: b.language, params: b.params })));

  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Payload too large' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    console.error('unhandled error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  });
  return app;
}

function defaultOnEvent(payload) {
  // Placeholder: log message/status counts only (no message content or phone numbers).
  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const v = change?.value ?? {};
      console.log(`whatsapp webhook: ${v.messages?.length ?? 0} message(s), ${v.statuses?.length ?? 0} status(es)`);
    }
  }
}
