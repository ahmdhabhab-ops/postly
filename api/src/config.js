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
    // Competitor discovery runs many web searches, so it uses a cheaper model by default.
    searchModel: get('ANTHROPIC_SEARCH_MODEL') || 'claude-haiku-4-5',
    geminiApiKey: get('GEMINI_API_KEY'),
    imageModel: get('GEMINI_IMAGE_MODEL') || 'models/gemini-3.1-flash-lite-image',
    imagesPerDay: Number(get('IMAGES_PER_DAY') || 10),
    helpName: get('WEBSITE_HELP_NAME') || 'Hostbotics',
    helpUrl: get('WEBSITE_HELP_URL') || 'https://hostbotics.net/',
    whatsapp: wa,
    whatsappEnabled: Boolean(wa.accessToken && wa.phoneNumberId),
    webhookEnabled: Boolean(wa.verifyToken && wa.appSecret),
  };
}
