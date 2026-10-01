import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const COOKIE = 'postly_sid';

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const [alg, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export async function createSession(pool, userId, days) {
  const token = crypto.randomBytes(32).toString('base64url');
  await pool.query(
    `insert into sessions(token_hash, user_id, expires_at) values ($1,$2, now() + ($3 || ' days')::interval)`,
    [sha256(token), userId, String(days)],
  );
  return token;
}

export function setSessionCookie(req, res, token, days) {
  const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${days * 86400}`];
  if (req.secure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(req, res) {
  const parts = [`${COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (req.secure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

export async function destroySession(pool, req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) await pool.query('delete from sessions where token_hash = $1', [sha256(token)]);
}

// Loads req.user from the session cookie, or leaves it undefined.
export function sessionLoader(pool) {
  return async (req, _res, next) => {
    try {
      const token = parseCookies(req.headers.cookie)[COOKIE];
      if (token) {
        const { rows } = await pool.query(
          `select u.id, u.email, u.first_name, u.last_name, u.phone
             from sessions s join users u on u.id = s.user_id
            where s.token_hash = $1 and s.expires_at > now()`,
          [sha256(token)],
        );
        if (rows[0]) req.user = rows[0];
      }
      next();
    } catch (e) { next(e); }
  };
}

export const requireUser = (req, res, next) =>
  req.user ? next() : res.status(401).json({ error: 'Please log in' });

// CSRF defence for cookie auth: SameSite=Lax + JSON-only bodies + same-origin check.
export function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (origin) {
    let host;
    try { host = new URL(origin).host; } catch { return res.status(403).json({ error: 'Bad origin' }); }
    if (host !== req.get('host')) return res.status(403).json({ error: 'Bad origin' });
  }
  if (!req.is('application/json')) return res.status(415).json({ error: 'JSON required' });
  next();
}
