import crypto from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import {
  ValidationError, createWhatsAppClient, safeEqual, verifySignature,
} from './whatsapp.js';
import {
  hashPassword, verifyPassword, createSession, setSessionCookie, clearSessionCookie,
  destroySession, sessionLoader, requireUser, csrfGuard,
} from './auth.js';
import { assistantReply, detectCampaignRequest, buildAssistantContext } from './assistant.js';
import { fetchPublicPage, parsePublicUrl, FetchBlockedError } from './safefetch.js';
import { analyzeCompetitor, buildStats, writeReport, discoverCompetitors } from './insights.js';
import { extractPage } from './safefetch.js';
import { generateBrief, siteSignals, websiteNotes, sanitizeBrief, classifyFetchError } from './brief.js';

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const CHANNELS = ['Instagram', 'Facebook', 'Meta Ads', 'TikTok', 'Google Business Profile', 'ChatGPT Ads', 'WhatsApp'];
const BUSINESS_FIELDS = {
  name: 120, type: 60, industry: 60, website: 200, location: 120, description: 1000,
  goal: 120, country: 400, usp: 1000, price_range: 60, customer_age: 20, customer_type: 30, customer_location: 120, interests: 300, budget: 40,
};

// Several markets are stored in one text column separated by " | ".
export function normalizeCountries(raw) {
  const seen = new Set(); const out = [];
  for (const part of String(raw).split('|')) {
    const v = part.trim();
    if (!v || seen.has(v.toLowerCase())) continue;
    if (v.length > 50) throw new ValidationError('Each country name must be 50 characters or less');
    seen.add(v.toLowerCase()); out.push(v);
  }
  if (out.length > 6) throw new ValidationError('Choose up to 6 countries');
  return out.join(' | ');
}

const str = (v, max, field) => {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string' || v.length > max) throw new ValidationError(`${field} is invalid or too long`);
  return v.trim();
};

export function createApp(cfg, { pool, wa = createWhatsAppClient(cfg.whatsapp), onEvent = defaultOnEvent, fetchImpl = fetch, fetchPage = fetchPublicPage } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', cfg.trustProxyHops);
  app.use(helmet());

  app.get('/healthz', (_req, res) => res.type('text/plain').send('ok'));

  // ---------- WhatsApp webhook (Meta). Raw body needed for the HMAC check. ----------
  app.get('/api/whatsapp/webhook', (req, res) => {
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
    if (cfg.webhookEnabled && mode === 'subscribe' && typeof token === 'string' && safeEqual(token, cfg.whatsapp.verifyToken)) {
      return res.status(200).type('text/plain').send(String(challenge ?? ''));
    }
    res.sendStatus(403);
  });
  app.post('/api/whatsapp/webhook', express.raw({ type: 'application/json', limit: '1mb' }), (req, res) => {
    if (!cfg.webhookEnabled || !verifySignature(req.body, req.get('x-hub-signature-256'), cfg.whatsapp.appSecret)) {
      return res.sendStatus(401);
    }
    let payload;
    try { payload = JSON.parse(req.body.toString('utf8')); } catch { return res.sendStatus(400); }
    res.sendStatus(200);
    try { onEvent(payload); } catch (e) { console.error('webhook handler error:', e.message); }
  });

  // ---------- Everything below: JSON + cookie sessions ----------
  const api = express.Router();
  api.use(express.json({ limit: '16kb' }));
  api.use(csrfGuard);
  api.use(sessionLoader(pool));

  const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });
  const writeLimiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false });
  const chatLimiter = rateLimit({ windowMs: 60_000, limit: 15, standardHeaders: true, legacyHeaders: false });
  const aiLimiter = rateLimit({ windowMs: 3_600_000, limit: 20, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => req.user?.id ?? 'anon', validate: false });
  const sendLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });

  const wrap = (fn) => async (req, res, next) => {
    try { await fn(req, res); } catch (e) { next(e); }
  };
  const log = (userId, text) => pool.query('insert into activity(user_id, text) values ($1,$2)', [userId, text]);

  // --- auth ---
  api.post('/auth/register', authLimiter, wrap(async (req, res) => {
    const b = req.body ?? {};
    const email = str(b.email, 254, 'email').toLowerCase();
    const password = typeof b.password === 'string' ? b.password : '';
    if (!EMAIL.test(email)) throw new ValidationError('Enter a valid email');
    if (password.length < 8 || password.length > 200) throw new ValidationError('Password must be 8-200 characters');
    const id = crypto.randomUUID();
    const hash = await hashPassword(password);
    try {
      await pool.query(
        'insert into users(id,email,password_hash,first_name,last_name,phone) values ($1,$2,$3,$4,$5,$6)',
        [id, email, hash, str(b.firstName, 60, 'firstName'), str(b.lastName, 60, 'lastName'), str(b.phone, 30, 'phone')],
      );
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'An account with this email already exists' });
      throw e;
    }
    await pool.query('insert into businesses(user_id, name) values ($1,$2)', [id, str(b.businessName, 120, 'businessName')]);
    await log(id, 'Account created — your AI team is getting set up');
    setSessionCookie(req, res, await createSession(pool, id, cfg.sessionDays), cfg.sessionDays);
    res.status(201).json(await meResponse(id));
  }));

  api.post('/auth/login', authLimiter, wrap(async (req, res) => {
    const email = str(req.body?.email, 254, 'email').toLowerCase();
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const { rows } = await pool.query('select id, password_hash from users where email = $1', [email]);
    // Always run a hash comparison so response time does not reveal whether the email exists.
    const ok = await verifyPassword(password, rows[0]?.password_hash ?? 'scrypt$00$00');
    if (!rows[0] || !ok) return res.status(401).json({ error: 'Wrong email or password' });
    setSessionCookie(req, res, await createSession(pool, rows[0].id, cfg.sessionDays), cfg.sessionDays);
    res.json(await meResponse(rows[0].id));
  }));

  api.post('/auth/logout', wrap(async (req, res) => {
    await destroySession(pool, req);
    clearSessionCookie(req, res);
    res.json({ ok: true });
  }));

  async function meResponse(userId) {
    const u = (await pool.query('select id,email,first_name,last_name,phone from users where id=$1', [userId])).rows[0];
    const business = (await pool.query('select * from businesses where user_id=$1', [userId])).rows[0] ?? null;
    if (business) { delete business.site_text; delete business.last_discovery_at; delete business.site_fetched_at; delete business.site_signals; } // internal cache of the user's own site text
    return { user: { id: u.id, email: u.email, firstName: u.first_name, lastName: u.last_name, phone: u.phone, canSendWhatsApp: isAdmin(u.email) }, business };
  }
  const isAdmin = (email) => cfg.adminEmails.includes(String(email).toLowerCase());

  api.get('/me', wrap(async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not logged in' });
    res.json(await meResponse(req.user.id));
  }));

  // --- business profile (onboarding + settings) ---
  api.put('/business', requireUser, writeLimiter, wrap(async (req, res) => {
    const b = req.body ?? {};
    const sets = [];
    const vals = [req.user.id];
    for (const [key, max] of Object.entries(BUSINESS_FIELDS)) {
      if (b[key] !== undefined) {
        const v = key === 'country' ? normalizeCountries(str(b[key], max, key)) : str(b[key], max, key);
        vals.push(v); sets.push(`${key} = $${vals.length}`);
      }
    }
    if (b.onboarded === true) sets.push('onboarded = true');
    if (!sets.length) throw new ValidationError('Nothing to update');
    await pool.query(`update businesses set ${sets.join(', ')}, updated_at = now() where user_id = $1`, vals);
    if (b.onboarded === true) await log(req.user.id, 'Reviewed your goal and started your first marketing plan');
    res.json(await meResponse(req.user.id));
  }));

  // --- campaigns ---
  api.get('/campaigns', requireUser, wrap(async (req, res) => {
    const { rows } = await pool.query('select * from campaigns where user_id=$1 order by created_at desc limit 100', [req.user.id]);
    const b = (await pool.query('select * from businesses where user_id=$1', [req.user.id])).rows[0];
    res.json({ campaigns: rows.map((r) => campaignOut(r, b)) });
  }));

  api.post('/campaigns/:id/plan', requireUser, aiLimiter, wrap(async (req, res) => {
    if (!/^[0-9a-f-]{36}$/.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const c = (await pool.query('select * from campaigns where id=$1 and user_id=$2', [req.params.id, req.user.id])).rows[0];
    if (!c) return res.status(404).json({ error: 'Not found' });
    const business = (await pool.query('select * from businesses where user_id=$1', [req.user.id])).rows[0];
    await refreshSiteText(req.user.id, business);
    const comps = (await pool.query('select name, reason from competitors where user_id=$1 order by created_at limit 5', [req.user.id])).rows;
    const { brief, ai } = await generateBrief({ cfg, business, campaign: c, competitors: comps, notes: notesFor(business, c.platform), fetchImpl });
    const row = (await pool.query('update campaigns set brief=$2 where id=$1 returning *', [c.id, JSON.stringify(brief)])).rows[0];
    res.json({ campaign: campaignOut(row, business), ai });
  }));
  api.delete('/campaigns/:id', requireUser, writeLimiter, wrap(async (req, res) => {
    if (!/^[0-9a-f-]{36}$/.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const r = await pool.query("delete from campaigns where id=$1 and user_id=$2 and status in ('pending','draft')", [req.params.id, req.user.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Only drafts awaiting approval can be discarded' });
    await log(req.user.id, 'You discarded a campaign draft');
    res.json({ ok: true });
  }));
  api.post('/campaigns/:id/approve', requireUser, writeLimiter, wrap(async (req, res) => {
    if (!/^[0-9a-f-]{36}$/.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const { rows } = await pool.query(
      `update campaigns set status='live', launched_at=now()
        where id=$1 and user_id=$2 and status='pending' returning *`,
      [req.params.id, req.user.id],
    );
    if (!rows[0]) return res.status(404).json({ error: 'Campaign not found or not awaiting approval' });
    await log(req.user.id, `You approved "${rows[0].title}"`);
    const b = (await pool.query('select * from businesses where user_id=$1', [req.user.id])).rows[0];
    res.json({ campaign: campaignOut(rows[0], b) });
  }));

  // --- channels (records which accounts the user marked as connected; real OAuth comes later) ---
  api.get('/channels', requireUser, wrap(async (req, res) => {
    const { rows } = await pool.query('select platform, account_label from channels where user_id=$1', [req.user.id]);
    res.json({ channels: rows });
  }));
  api.put('/channels/:platform', requireUser, writeLimiter, wrap(async (req, res) => {
    const platform = CHANNELS.find((c) => c === req.params.platform);
    if (!platform) throw new ValidationError('Unknown channel');
    const label = str(req.body?.accountLabel, 120, 'accountLabel');
    if (req.body?.connected === false) {
      await pool.query('delete from channels where user_id=$1 and platform=$2', [req.user.id, platform]);
    } else {
      await pool.query(
        `insert into channels(user_id, platform, account_label) values ($1,$2,$3)
         on conflict (user_id, platform) do update set account_label = excluded.account_label`,
        [req.user.id, platform, label],
      );
    }
    res.json({ ok: true });
  }));

  // --- assistant chat ---
  api.get('/chat', requireUser, wrap(async (req, res) => {
    const { rows } = await pool.query(
      `select role, content from (select id, role, content from chat_messages where user_id=$1 order by id desc limit 50) t order by id`,
      [req.user.id],
    );
    res.json({ messages: rows });
  }));
  api.post('/chat', requireUser, chatLimiter, wrap(async (req, res) => {
    const text = str(req.body?.message, 1000, 'message');
    if (!text) throw new ValidationError('Message is empty');
    const business = (await pool.query('select * from businesses where user_id=$1', [req.user.id])).rows[0];
    const history = (await pool.query(
      `select role, content from (select id, role, content from chat_messages where user_id=$1 order by id desc limit 10) t order by id`,
      [req.user.id],
    )).rows;
    await refreshSiteText(req.user.id, business);
    const comps = (await pool.query('select name, url, market, reason, analysis from competitors where user_id=$1 order by created_at limit 8', [req.user.id])).rows;
    const draft = detectCampaignRequest(text, business);
    let campaign = null;
    let reused = false;
    if (draft) {
      campaign = (await pool.query(
        "select * from campaigns where user_id=$1 and platform=$2 and status='pending' order by created_at desc limit 1",
        [req.user.id, draft.platform])).rows[0] ?? null;
      reused = Boolean(campaign);
    }
    if (draft && !campaign) {
      campaign = (await pool.query(
        `insert into campaigns(id,user_id,title,platform,status,budget_per_day,duration_days,audience,expected_leads)
         values ($1,$2,$3,$4,'pending',$5,$6,$7,$8) returning *`,
        [crypto.randomUUID(), req.user.id, draft.title, draft.platform, draft.budget_per_day, draft.duration_days, draft.audience, draft.expected_leads],
      )).rows[0];
      const { brief } = await generateBrief({ cfg, business, campaign, competitors: comps, notes: notesFor(business, campaign.platform), fetchImpl });
      campaign = (await pool.query('update campaigns set brief=$2 where id=$1 returning *', [campaign.id, JSON.stringify(brief)])).rows[0];
      await log(req.user.id, `Drafted "${campaign.title}" for your approval`);
    }
    const camps = await pool.query('select title, platform, status, budget_per_day, duration_days from campaigns where user_id=$1 order by created_at desc limit 8', [req.user.id]);
    const context = buildAssistantContext({ business, competitors: comps, campaigns: camps.rows, websiteNotes: notesFor(business) });
    const reply = await assistantReply({ cfg, context, history, text, campaign, reused, fetchImpl });
    await pool.query('insert into chat_messages(user_id, role, content) values ($1,$2,$3), ($1,$4,$5)', [req.user.id, 'user', text, 'assistant', reply]);
    res.json({ reply, campaign: campaign ? campaignOut(campaign, business) : null });
  }));

  // Reads the owner's own website once a week (or when it was never read) so the assistant knows the business,
  // and checks it for things ads need (HTTPS, mobile, contact, Meta Pixel). Failures are remembered for an hour.
  async function refreshSiteText(userId, business, { force = false } = {}) {
    if (!business?.website) return;
    const fresh = business.site_fetched_at && Date.now() - new Date(business.site_fetched_at).getTime() < (business.site_text ? 7 * 86_400_000 : 3_600_000);
    if (fresh && !force) return;
    try {
      const url = /^https?:\/\//i.test(business.website) ? business.website : `https://${business.website}`;
      const html = await fetchPage(url);
      const p = extractPage(html);
      business.site_text = `${p.title}. ${p.description}. ${p.text}`.slice(0, 4000);
      business.site_signals = JSON.stringify(siteSignals(html, url));
      await pool.query('update businesses set site_text=$2, site_signals=$3, site_fetched_at=now() where user_id=$1', [userId, business.site_text, business.site_signals]);
    } catch (e) {
      business.site_signals = JSON.stringify({ ok: false, reason: classifyFetchError(e) });
      await pool.query('update businesses set site_signals=$2, site_fetched_at=now() where user_id=$1', [userId, business.site_signals]);
    }
  }
  const parseSignals = (b) => { try { return b?.site_signals ? JSON.parse(b.site_signals) : null; } catch { return null; } };
  const notesFor = (b, platform) => websiteNotes({ business: b, signals: parseSignals(b), cfg, platform });
  const briefOf = (row) => { try { return row.brief ? JSON.parse(row.brief) : null; } catch { return null; } };
  const campaignOut = (row, b) => { const { brief, ...rest } = row; return { ...rest, brief: briefOf(row), website_notes: b ? notesFor(b, row.platform) : [] }; };

  // --- dashboard ---
  api.get('/dashboard', requireUser, wrap(async (req, res) => {
    const id = req.user.id;
    const counts = (await pool.query(
      `select count(*) filter (where status='live')::int as live,
              count(*) filter (where status='pending')::int as pending,
              count(*)::int as total,
              coalesce(sum(budget_per_day) filter (where status='live'),0)::int as daily_spend
         from campaigns where user_id=$1`, [id])).rows[0];
    const channels = (await pool.query('select count(*)::int as n from channels where user_id=$1', [id])).rows[0].n;
    const activity = (await pool.query('select text, created_at from activity where user_id=$1 order by id desc limit 8', [id])).rows;
    res.json({ ...counts, channels, activity });
  }));

  // --- competitors ---
  const competitorRow = (r) => ({ id: r.id, name: r.name, url: r.url, market: r.market, reason: r.reason, source: r.source, analysis: r.analysis, analyzed_at: r.analyzed_at });
  api.get('/competitors', requireUser, wrap(async (req, res) => {
    const { rows } = await pool.query('select * from competitors where user_id=$1 order by created_at', [req.user.id]);
    res.json({ competitors: rows.map(competitorRow) });
  }));
  api.post('/competitors/discover', requireUser, aiLimiter, wrap(async (req, res) => {
    if (!cfg.anthropicApiKey) return res.status(503).json({ error: 'AI is not enabled on this server (ANTHROPIC_API_KEY missing)' });
    const business = (await pool.query('select * from businesses where user_id=$1', [req.user.id])).rows[0];
    if (!business || (!business.description && !business.website)) {
      throw new ValidationError('Describe your business or add your website first');
    }
    await refreshSiteText(req.user.id, business, { force: true });
    // One AI discovery per 24h per user (operators in ADMIN_EMAILS are exempt). Failed calls give the slot back.
    const operator = isAdmin(req.user.email);
    const prev = business.last_discovery_at;
    if (!operator) {
      const claim = await pool.query(
        `update businesses set last_discovery_at = now()
          where user_id = $1 and (last_discovery_at is null or last_discovery_at < now() - interval '24 hours')
          returning 1`, [req.user.id]);
      if (!claim.rowCount) {
        const hrs = Math.max(1, Math.ceil((new Date(prev).getTime() + 86_400_000 - Date.now()) / 3_600_000));
        return res.status(429).json({ error: `AI competitor search can run once per day to keep costs low. Try again in about ${hrs} hour${hrs === 1 ? '' : 's'}.` });
      }
    }
    const refund = () => (operator ? null : pool.query('update businesses set last_discovery_at = $2 where user_id = $1', [req.user.id, prev]));
    let found;
    try { found = await discoverCompetitors({ cfg, business, fetchImpl }); } catch (e) { await refund(); throw e; }
    if (found === null) await refund();
    if (found === null) return res.status(502).json({ error: 'The AI search did not respond. Try again in a minute.' });
    const existing = (await pool.query('select url from competitors where user_id=$1', [req.user.id])).rows;
    const hostOf = (u) => { try { return new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`).hostname.replace(/^www\./, ''); } catch { return ''; } };
    const seen = new Set([...existing.map((r) => hostOf(r.url)), hostOf(business.website || '')].filter(Boolean));
    let slots = 10 - existing.length;
    const added = [];
    for (const c of found) {
      if (slots <= 0) break;
      const name = typeof c?.name === 'string' ? c.name.trim().slice(0, 100) : '';
      let url = typeof c?.url === 'string' ? c.url.trim().slice(0, 300) : '';
      if (!name || !url) continue;
      if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
      try { parsePublicUrl(url); } catch { continue; }
      const host = hostOf(url);
      if (!host || seen.has(host)) continue;
      seen.add(host); slots--;
      const why = typeof c.why === 'string' ? c.why.trim().slice(0, 200) : '';
      const market = typeof c.country === 'string' ? c.country.trim().slice(0, 60) : '';
      const { rows } = await pool.query(
        "insert into competitors(id,user_id,name,url,reason,source,market) values ($1,$2,$3,$4,$5,'ai',$6) returning *",
        [crypto.randomUUID(), req.user.id, name, url, why, market]);
      added.push(competitorRow(rows[0]));
    }
    await log(req.user.id, `AI found ${added.length} competitor(s) for you`);
    res.json({ added, found: found.length });
  }));
  api.post('/competitors', requireUser, writeLimiter, wrap(async (req, res) => {
    const name = str(req.body?.name, 100, 'name');
    let url = str(req.body?.url, 300, 'url');
    if (!name || !url) throw new ValidationError('Name and website are required');
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    try { parsePublicUrl(url); } catch (e) { throw new ValidationError(e.message); }
    const n = (await pool.query('select count(*)::int as n from competitors where user_id=$1', [req.user.id])).rows[0].n;
    if (n >= 10) throw new ValidationError('You can track up to 10 competitors');
    const { rows } = await pool.query('insert into competitors(id,user_id,name,url) values ($1,$2,$3,$4) returning *', [crypto.randomUUID(), req.user.id, name, url]);
    res.status(201).json({ competitor: competitorRow(rows[0]) });
  }));
  api.delete('/competitors/:id', requireUser, writeLimiter, wrap(async (req, res) => {
    if (!/^[0-9a-f-]{36}$/.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
    await pool.query('delete from competitors where id=$1 and user_id=$2', [req.params.id, req.user.id]);
    res.json({ ok: true });
  }));
  api.post('/competitors/:id/analyze', requireUser, aiLimiter, wrap(async (req, res) => {
    if (!/^[0-9a-f-]{36}$/.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const c = (await pool.query('select * from competitors where id=$1 and user_id=$2', [req.params.id, req.user.id])).rows[0];
    if (!c) return res.status(404).json({ error: 'Not found' });
    let html;
    try { html = await fetchPage(c.url); } catch (e) {
      const msg = e instanceof FetchBlockedError ? e.message : 'Could not load that website';
      return res.status(422).json({ error: msg });
    }
    const business = (await pool.query('select * from businesses where user_id=$1', [req.user.id])).rows[0];
    const result = await analyzeCompetitor({ cfg, business, competitor: c, html, fetchImpl });
    const { rows } = await pool.query('update competitors set analysis=$3, analyzed_at=now() where id=$1 and user_id=$2 returning *', [c.id, req.user.id, result.text]);
    await log(req.user.id, `Analysed competitor ${c.name}`);
    res.json({ competitor: competitorRow(rows[0]), ai: result.ai });
  }));

  // --- reports ---
  api.get('/reports', requireUser, wrap(async (req, res) => {
    const { rows } = await pool.query('select id, content, ai, created_at from reports where user_id=$1 order by id desc limit 10', [req.user.id]);
    res.json({ reports: rows });
  }));
  api.post('/reports', requireUser, aiLimiter, wrap(async (req, res) => {
    const id = req.user.id;
    const camps = (await pool.query('select status, platform, budget_per_day from campaigns where user_id=$1', [id])).rows;
    const activity = (await pool.query('select text from activity where user_id=$1 order by id desc limit 10', [id])).rows.map((r) => r.text);
    const business = (await pool.query('select * from businesses where user_id=$1', [id])).rows[0];
    const stats = buildStats(camps);
    const out = await writeReport({ cfg, business, stats, activity, fetchImpl });
    const { rows } = await pool.query('insert into reports(user_id, content, ai, stats) values ($1,$2,$3,$4) returning id, content, ai, created_at', [id, out.text, out.ai, JSON.stringify(stats)]);
    res.status(201).json({ report: rows[0] });
  }));

  // --- WhatsApp send: only the operator (ADMIN_EMAILS session, or X-API-Key) may send ---
  const requireSender = (req, res, next) => {
    if (!cfg.whatsappEnabled) return res.status(503).json({ error: 'WhatsApp is not configured on the server' });
    const key = req.get('x-api-key');
    if (key && cfg.adminApiKey && safeEqual(key, cfg.adminApiKey)) return next();
    if (req.user && isAdmin(req.user.email)) return next();
    res.status(req.user ? 403 : 401).json({ error: req.user ? 'Not allowed' : 'Unauthorized' });
  };
  const waHandle = (fn) => wrap(async (req, res) => {
    try {
      const out = await fn(req.body ?? {});
      await pool.query('insert into whatsapp_log(user_id, message_id) values ($1,$2)', [req.user?.id ?? null, out.messageId]);
      res.json(out);
    } catch (e) {
      if (e instanceof ValidationError) return res.status(400).json({ error: e.message });
      console.error('whatsapp send failed:', e.upstreamStatus, e.upstreamCode, e.upstreamMessage ?? e.message);
      res.status(502).json({ error: 'Could not send WhatsApp message' });
    }
  });
  api.post('/whatsapp/send', sendLimiter, requireSender, waHandle((b) => wa.sendText(b.to, b.body)));
  api.post('/whatsapp/send-template', sendLimiter, requireSender, waHandle((b) =>
    wa.sendTemplate(b.to, { name: b.name, language: b.language, params: b.params })));

  api.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use('/api', api);

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Payload too large' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    console.error('unhandled error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  });
  return app;
}

function defaultOnEvent(payload) {
  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const v = change?.value ?? {};
      console.log(`whatsapp webhook: ${v.messages?.length ?? 0} message(s), ${v.statuses?.length ?? 0} status(es)`);
    }
  }
}
