# Postly

- `public/` static frontend (nginx)
- `api/` Node/Express backend: accounts (email + password, HttpOnly session cookie), business profile,
  campaigns, assistant chat, channels, WhatsApp Cloud API
- `db` Postgres 16 (internal only)
- nginx proxies `/api/*` to the `api` container; `api` and `db` publish no ports.

## What is real vs sample
Real, stored per user in Postgres: accounts/login, onboarding profile, campaigns (drafted by the assistant, approved by you),
assistant chat history, channel records, activity feed, WhatsApp sending (operator only).
Sample data (labelled in the UI): Ads, Analytics, Competitors, AI Search, Content, Billing.
Publishing to ad platforms (Meta/Google/TikTok) and OAuth channel connections are not built yet.
The assistant uses Claude when `ANTHROPIC_API_KEY` is set, otherwise simple built-in replies.

## Deploy (Dokploy)
Compose path `./docker-compose.yml`; put the variables from `.env.example` in the Environment tab
(`DB_PASSWORD` is required). Domains tab: service `web`, port `3000`.

## Security model
- Passwords: scrypt + per-user salt. Sessions: random token, only its SHA-256 stored; cookie is HttpOnly, SameSite=Lax, Secure over HTTPS.
- CSRF: SameSite cookies + JSON-only bodies + same-origin check. Rate limits on login/register, chat, writes and sends.
- WhatsApp token lives only in the server env. Sending is allowed only for emails in `ADMIN_EMAILS` (or `X-API-Key`), so
  normal sign-ups cannot send messages from your number. Webhook: verify token + `X-Hub-Signature-256` check.
  Set Meta callback to `https://YOUR_DOMAIN/api/whatsapp/webhook` (needs a real domain with HTTPS).

## Tests
`cd api && TEST_DATABASE_URL=postgres://... npm test` (needs a Postgres).
