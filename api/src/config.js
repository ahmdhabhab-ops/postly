// All secrets come from the server environment only. Nothing here is ever sent to the browser.

export function loadConfig(env = process.env) {
  const get = (n) => env[n];
  const need = (n) => {
    if (!get(n)) throw new Error(`Missing required env var ${n}`);
    return get(n);
  };
  return {
    port: Number(get('PORT') || 4000),
    graphVersion: get('WHATSAPP_GRAPH_VERSION') || 'v21.0',
    accessToken: need('WHATSAPP_ACCESS_TOKEN'),
    phoneNumberId: need('WHATSAPP_PHONE_NUMBER_ID'),
    verifyToken: need('WHATSAPP_VERIFY_TOKEN'),
    appSecret: need('WHATSAPP_APP_SECRET'),
    adminApiKey: need('ADMIN_API_KEY'),
    corsOrigin: get('CORS_ORIGIN') || '',
  };
}

