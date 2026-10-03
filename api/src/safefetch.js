import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

export class FetchBlockedError extends Error {}

export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::' || v === '::1') return true;
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return /^(fc|fd|fe[89ab])/.test(v) || v.startsWith('ff');
  }
  return true; // not an IP we understand
}

// Used as the socket's `lookup`: the address we validate is the address we connect to (no DNS-rebinding gap).
function guardedLookup(hostname, options, cb) {
  if (typeof options === 'function') { cb = options; options = {}; }
  dns.lookup(hostname, { all: true, ...(options?.family ? { family: options.family } : {}) }, (err, addrs) => {
    if (err) return cb(err);
    if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) {
      return cb(new FetchBlockedError('Address not allowed'));
    }
    if (options?.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  });
}

// "example.com/x" -> "https://example.com/x"; any other scheme (file:, ftp:, javascript:, ...) is rejected, never rewritten.
export function withHttps(input) {
  const v = String(input ?? '').trim();
  if (/^https?:\/\//i.test(v)) return v;
  if (/^[a-z][a-z0-9+.-]*:(\/\/|[^0-9])/i.test(v)) throw new FetchBlockedError('Only http(s) URLs are allowed');
  return `https://${v}`;
}

export function parsePublicUrl(input) {
  let u;
  try { u = new URL(input); } catch { throw new FetchBlockedError('Invalid URL'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new FetchBlockedError('Only http(s) URLs are allowed');
  if (u.username || u.password) throw new FetchBlockedError('URLs with credentials are not allowed');
  if (u.port && !['80', '443'].includes(u.port)) throw new FetchBlockedError('Port not allowed');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && isPrivateAddress(host)) throw new FetchBlockedError('Address not allowed');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new FetchBlockedError('Address not allowed');
  }
  return u;
}

function once(url, { timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(url, {
      method: 'GET', lookup: guardedLookup, timeout: timeoutMs,
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; PostlyBot/1.0; website check requested by the site owner)', accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9' },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return resolve({ redirect: new URL(res.headers.location, url).href });
      }
      if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); return reject(new FetchBlockedError(`Site returned ${res.statusCode}`)); }
      if (!/text\/html|application\/xhtml/i.test(res.headers['content-type'] || '')) { res.resume(); return reject(new FetchBlockedError('Not an HTML page')); }
      const chunks = []; let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) { res.destroy(); resolve({ body: Buffer.concat(chunks).toString('utf8') }); }
        else chunks.push(c);
      });
      res.on('end', () => resolve({ body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new FetchBlockedError('Site took too long to respond')));
    req.on('error', reject);
    req.end();
  });
}

export async function fetchPublicPage(input, { timeoutMs = 8000, maxBytes = 400_000, maxRedirects = 3 } = {}) {
  let url = parsePublicUrl(input);
  for (let i = 0; i <= maxRedirects; i++) {
    const r = await once(url, { timeoutMs, maxBytes });
    if (r.body !== undefined) return r.body;
    url = parsePublicUrl(r.redirect); // every hop is re-validated
  }
  throw new FetchBlockedError('Too many redirects');
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
const decode = (s) => s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m]);

export function extractPage(html) {
  const pick = (re) => decode((html.match(re)?.[1] ?? '').replace(/\s+/g, ' ').trim());
  const title = pick(/<title[^>]*>([\s\S]*?)<\/title>/i).slice(0, 200);
  const description = pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i).slice(0, 400);
  const text = decode(
    html.replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' '),
  ).replace(/\s+/g, ' ').trim().slice(0, 6000);
  return { title, description, text };
}
