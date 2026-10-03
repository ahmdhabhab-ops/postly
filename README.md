# Postly

- `public/` static frontend (nginx)
- `api/` Node/Express backend: accounts (email + password, HttpOnly session cookie), business profile,
  campaigns, assistant chat, channels, WhatsApp Cloud API
- `db` Postgres 16 (internal only)
- nginx proxies `/api/*` to the `api` container; `api` and `db` publish no ports.

## What is real vs sample
Real, stored per user in Postgres: accounts/login, onboarding profile, campaigns (drafted by the assistant, approved by you),
assistant chat history, activity feed, AI competitor discovery (Claude + web search from your business profile), competitor comparison (reads the competitor's public page), AI marketing reports
(written from your Postly data only), WhatsApp sending (operator only).
Sample data (labelled in the UI): Ads, Analytics numbers, AI Search, Content, Billing. Channel "Connect" buttons show Coming soon.
Publishing to ad platforms (Meta/Google/TikTok) and OAuth channel connections are not built yet.
Competitor discovery runs on a cheaper model (`ANTHROPIC_SEARCH_MODEL`, default Haiku 4.5), at most once per 24h per user (operators in `ADMIN_EMAILS` are exempt; a failed call does not use the slot). It needs `ANTHROPIC_API_KEY` and web search enabled for your organisation in the Anthropic Console.
The assistant uses Claude when `ANTHROPIC_API_KEY` is set, otherwise simple built-in replies.

## Campaign plans and website check
Each drafted campaign gets a full plan (objective, ages, interests, placements, creative ideas, copy, KPIs). Where the owner gave no
details, the AI suggests them and lists them as assumptions. The owner's website is checked by code (HTTPS, mobile viewport, contact path,
Meta Pixel, amount of content); problems are shown on the campaign and given to the assistant, with a pointer to `WEBSITE_HELP_NAME` /
`WEBSITE_HELP_URL` (default Hostbotics). "Copy plan" lets the client create the ad manually until the Meta integration exists.

## Choosing the platform, and taking the plan with you
Before any draft, the client can ask "Where should you advertise?": the AI ranks Instagram, Facebook, Google, TikTok and ChatGPT Ads for the
business (fit, why, budget share, first step) and the client chooses. The chat assistant follows the same advice and does not draft until a
platform is chosen. A plan opens in a full window (View full plan) with Download Excel (.xlsx with a step-by-step "launch manually" sheet),
Print / Save as PDF and Copy.

## How the assistant creates campaigns
With an AI key the assistant has a real tool, `create_campaign_draft`. It calls the tool as soon as the user asks for a campaign in any
language (including Arabic written in Latin letters, "meta" = Instagram + Facebook); the server creates or reuses the draft and returns
the result to the model, so the reply always matches reality. Without a key a rule-based fallback handles the common phrasings.

## New customers (prospecting)
The Customers page builds an ideal-customer profile, then (once per 24h per user, cheaper search model) asks the AI to search the public web for
(a) businesses that need or could refer the offer and (b) public posts where someone says they are looking for it. Safeguards: results must
be real URLs (links are fetched with the SSRF-safe client; dead links dropped, unreachable ones marked unverified); emails, phone numbers and
@handles are stripped; private people are never named ("Public post on <site>"); the intent score is computed in code from yes/no evidence
flags (asked for it, date/urgency, budget, in market, clear need). Nothing is sent automatically: the owner writes to each lead manually,
because WhatsApp and email rules require consent. Do not add bulk sending to this list.

## Nothing is assumed about the client
Onboarding pre-selects nothing: type, industry, goal, budget and customer type start empty, and age groups are a multi-select (with "All ages" and
"Not sure"). Empty means unknown: plans then use broad targeting (ages 18-65) and list suggestions as assumptions. Everything can be edited later in
Settings. Campaign budgets follow the stated monthly budget (split by the channel advice, or evenly over the platforms created together), and the
assistant can create drafts on several platforms in one request ("all platforms").

## Deploy (Dokploy)
Compose path `./docker-compose.yml`; put the variables from `.env.example` in the Environment tab
(`DB_PASSWORD` is required). Domains tab: service `web`, port `3000`.

## Security model
- Passwords: scrypt + per-user salt. Sessions: random token, only its SHA-256 stored; cookie is HttpOnly, SameSite=Lax, Secure over HTTPS.
- CSRF: SameSite cookies + JSON-only bodies + same-origin check. Rate limits on login/register, chat, writes and sends.
- Competitor URLs are fetched server-side with SSRF protection (http/https on 80/443 only, private/loopback/metadata IPs blocked at connect time,
  every redirect re-checked, 8s timeout, 400KB cap). Page text is passed to the model as untrusted data. AI endpoints are rate limited per user.
- WhatsApp token lives only in the server env. Sending is allowed only for emails in `ADMIN_EMAILS` (or `X-API-Key`), so
  normal sign-ups cannot send messages from your number. Webhook: verify token + `X-Hub-Signature-256` check.
  Set Meta callback to `https://YOUR_DOMAIN/api/whatsapp/webhook` (needs a real domain with HTTPS).

## Lost password / who signed up (server operator)
Run inside the `api` container (Dokploy: Containers > api > Terminal):
```
node src/cli/list-users.js                       # emails and sign-up dates (never password hashes)
node src/cli/reset-password.js user@example.com   # prints a new random password and signs the user out everywhere
node src/cli/reset-password.js user@example.com 'chosen password'
```
Passwords are stored as scrypt hashes and cannot be read back by anyone. Users can change their own password in Settings > Account.

## Tests
`cd api && TEST_DATABASE_URL=postgres://... npm test` (needs a Postgres).
