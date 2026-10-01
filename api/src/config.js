// All secrets come from the server environment only. Nothing here is ever sent to the browser.
export function loadConfig(env = process.env) {
  const get = (n) => env[n] || '';
  const need = (n) => {
    if (!get(n)) throw new Error(`Missing required env var ${n}`);
    return get(n);
  };
  const wa = {
    accessToken: get('WHATSAPP_ACCESS_TOKEN'),
    phoneNumberId: get('WHATSAPP_PHONE_NUMBER_ID'),
    verifyToken: get('WHATSAPP_VERIFY_TOKEN'),
    appSecret: get('WHATSAPP_APP_SECRET'),
    graphVersion: get('WHATSAPP_GRAPH_VERSION') || 'v21.0',
  };
  return {
    port: Number(get('PORT') || 4000),
    databaseUrl: need('DATABASE_URL'),
    trustProxyHops: Number(get('TRUST_PROXY_HOPS') || 2),
    sessionDays: Number(get('SESSION_DAYS') || 14),
    adminEmails: get('ADMIN_EMAILS').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    adminApiKey: get('ADMIN_API_KEY'),
    anthropicApiKey: get('ANTHROPIC_API_KEY'),
    anthropicModel: get('ANTHROPIC_MODEL') || 'claude-sonnet-5-5',
    whatsapp: wa,
    whatsappEnabled: Boolean(wa.accessToken && wa.phoneNumberId),
    webhookEnabled: Boolean(wa.verifyToken && wa.appSecret),
  };
}
