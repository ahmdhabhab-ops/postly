# Postly

- `public/` static frontend (nginx)
- `api/` Node/Express backend for the WhatsApp Cloud API
- nginx proxies `/api/*` to the `api` container; the `api` container has no published port.

## Deploy
```
cp .env.example .env   # fill in secrets
docker compose up -d --build
```
Site: served by Dokploy/Traefik on your domain (see below). Without Dokploy, add `ports: ["3001:3000"]` to the web service.

## Security model
- Meta access token lives only in `.env` -> api container env. Never in the image, never in `public/`, never in responses.
- `POST /api/whatsapp/send` and `/send-template` require header `X-API-Key: $ADMIN_API_KEY` (rate limited, input validated).
  Call them from trusted server code. Do NOT put ADMIN_API_KEY in browser JS; to call from the UI,
  add real user auth to the API first.
- Webhook `GET/POST /api/whatsapp/webhook`: verify token on handshake, `X-Hub-Signature-256` HMAC check on events.
  In Meta dashboard set callback URL to `https://YOUR_DOMAIN/api/whatsapp/webhook` (HTTPS required; put TLS in front).
