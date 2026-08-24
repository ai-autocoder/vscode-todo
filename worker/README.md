# agent-plans-auth-proxy

A tiny Cloudflare Worker that adds CORS headers to GitHub's **OAuth Device Flow** endpoints
so the Agent Plans **PWA** can complete sign-in from the browser.

## Why it exists

GitHub's device-flow endpoints live on `github.com` and send **no CORS headers**, so a
browser cannot call them directly. This Worker forwards **only** these two POSTs and echoes
the response with CORS headers:

- `POST /login/device/code`
- `POST /login/oauth/access_token`

It holds **no secrets** (device flow is a public-client flow keyed by a public `client_id`)
and refuses every other path, so it cannot be used as a general open proxy.

> Gist read/write is **not** proxied — `api.github.com` already allows CORS, so the PWA calls
> it directly with the token.

## One-time setup

1. Create a **GitHub OAuth App** (Settings → Developer settings → OAuth Apps). Enable
   **Device Flow**. Copy the **Client ID** (public). No client secret is needed.
2. Install deps and log in:
   ```bash
   cd worker
   npm install
   npx wrangler login
   ```

## Develop & deploy

```bash
npm run dev      # local: http://127.0.0.1:8787
npm run deploy   # publishes to https://agent-plans-auth-proxy.<your-subdomain>.workers.dev
```

## Configuration (`wrangler.toml` → `[vars]`)

| Var | Purpose |
| --- | --- |
| `ALLOWED_ORIGINS` | Comma-separated browser origins, or `*`. Set to your Pages URL in production. |
| `CLIENT_ID` | Optional. When set, only requests carrying this `client_id` are forwarded. |

Point the PWA at the deployed URL via its `deviceFlow.proxyBaseUrl` config.

## Quick check

```bash
curl -i -X POST "$WORKER_URL/login/device/code" \
  -H "Content-Type: application/json" -H "Origin: http://localhost:4200" \
  -d '{"client_id":"<your-client-id>","scope":"gist"}'
# Expect 200 with a JSON body containing user_code + verification_uri and
# an Access-Control-Allow-Origin header.
```
