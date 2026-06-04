# mpp-e2b

Pay-per-use [E2B](https://e2b.dev) cloud sandbox proxy built with [mppx](https://github.com/wevm/mppx). Deploy it on either Vercel Functions or Cloudflare Workers.

Create, manage, and execute code in isolated E2B sandboxes — pay with crypto via the [Machine Payments Protocol](https://mpp.dev).

## Endpoints

| Route | Price | Description |
|-------|-------|-------------|
| `POST /sandboxes` | Dynamic | Create a sandbox (priced by vCPU, RAM, timeout) |
| `GET /sandboxes` | $0.0001 | List running sandboxes |
| `GET /sandboxes/:id` | $0.0001 | Get sandbox details |
| `DELETE /sandboxes/:id` | $0.001 | Kill a sandbox |
| `POST /sandboxes/:id/connect` | $0.01 | Connect/resume a paused sandbox |
| `POST /sandboxes/:id/pause` | $0.001 | Pause a sandbox |
| `POST /sandboxes/:id/refreshes` | Dynamic | Refresh sandbox TTL (priced by spec × duration) |
| `POST /sandboxes/:id/timeout` | Dynamic | Set sandbox timeout (priced by spec × timeout) |
| `POST /sandboxes/:id/snapshots` | $0.01 | Create a persistent snapshot |
| `GET /sandboxes/:id/logs` | $0.0001 | Get sandbox logs |
| `GET /v2/sandboxes/:id/logs` | $0.0001 | Get sandbox logs (v2) |
| `GET /sandboxes/:id/metrics` | $0.0001 | Get sandbox metrics |

## Setup

```bash
pnpm install
```

### Vercel Functions

Set secrets in `.env.local` for local development, or in the Vercel project environment for deployments.

```bash
pnpm dev
pnpm run deploy
```

### Cloudflare Workers

Set secrets in `.dev.vars` for local development, or with `wrangler secret put` for deployments.

```bash
cp .dev.vars.example .dev.vars
pnpm dev:cf
pnpm run deploy:cf
```

## Scripts

| Command | Target |
|---------|--------|
| `pnpm dev` | Alias for `pnpm dev:vercel` |
| `pnpm dev:vercel` | Run locally with Vercel Functions |
| `pnpm run deploy` | Alias for `pnpm run deploy:vercel` |
| `pnpm run deploy:vercel` | Deploy to Vercel |
| `pnpm dev:cf` | Run locally with Cloudflare Workers |
| `pnpm run deploy:cf` | Deploy to Cloudflare Workers |
| `pnpm check` | Run typecheck, lint, and tests |
| `pnpm run smoke:local -- --create` | Smoke test local Vercel with paid sandbox create/delete |
| `SMOKE_BASE_URL=https://your-deployment.vercel.app pnpm run smoke:prod -- --create` | Smoke test a deployed Vercel URL with paid sandbox create/delete |

## Testing

Two layers, kept separate by two Vitest configs so the fast suite stays offline and free.

### Unit tests

Live in `src/__tests__/*.test.ts`. They run against `vitest.config.ts`, mock `fetch` and `mppx.charge`, and never touch the network or spend funds. They cover pure logic such as payer tagging and the dynamic pricing branches (real sandbox spec vs. default-spec fallback vs. 404 for a paid request to a missing sandbox). Run them with:

```bash
pnpm test       # or: pnpm check (typecheck + lint + tests)
```

### Smoke tests

Live in `scripts/smoke-e2b-proxy.smoke.ts` and run against a **real deployment** via `vitest.smoke.config.ts` (excluded from the unit suite). The `scripts/smoke-e2b-proxy.js` wrapper translates CLI flags into `SMOKE_*` env vars and launches the runner. Unpaid requests assert `402` on every route; paid requests shell out to the real `mppx` CLI, which performs the full pay-and-retry handshake against the Tempo testnet.

```bash
pnpm run smoke:local                                                  # challenges + paid GET only (creates nothing)
pnpm run smoke:local -- --create                                      # also create / get / delete a sandbox
pnpm run smoke:local -- --full                                        # full lifecycle (logs, metrics, timeout, refreshes, pause, connect)
SMOKE_BASE_URL=https://your-deployment.vercel.app pnpm run smoke:prod -- --full
```

| Flag | Adds |
|------|------|
| _(none)_ | OpenAPI surface check, `402` challenge on every route, paid `GET /sandboxes` |
| `--create` | paid create → get → delete of a sandbox |
| `--full` | full lifecycle endpoints on the created sandbox, with `afterAll` cleanup |

Other flags: `--base-url`, `--account`, `--rpc-url`, `--timeout`.

## Secrets

| Variable | Description |
|----------|-------------|
| `E2B_API_KEY` | E2B API key from [e2b.dev/dashboard](https://e2b.dev/dashboard) |
| `MPPX_SECRET_KEY` | Secret key for mppx payment verification |
| `PAYEE_ADDRESS` | Wallet address to receive payments |
| `FEE_PAYER_PRIVATE_KEY` | Private key for gas sponsoring (optional) |
| `TEMPO_ENV` | `tempo` (mainnet) or `moderato` (testnet) |
| `UPSTASH_REDIS_REST_URL` | Upstash Redis REST URL for replay protection (see below) |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST token |

### Replay protection store

mppx records each consumed payment credential so it can't be replayed. That record must
live in a **shared, persistent** store — an in-memory one is wiped per request on
serverless and offers no real protection. Set `UPSTASH_REDIS_REST_URL` /
`UPSTASH_REDIS_REST_TOKEN` (Upstash works on both Cloudflare and Vercel) **in production**.
If unset, the proxy falls back to an in-memory store and logs a warning — acceptable for
local dev only.

**Test it locally without a cloud account** — `docker compose up -d` starts a real Redis
behind the Upstash REST API, then point the vars at it:

```bash
UPSTASH_REDIS_REST_URL=http://localhost:8079
UPSTASH_REDIS_REST_TOKEN=local_token
```

For deployments, create a free database at [upstash.com](https://upstash.com) and copy its
REST URL/token into the Vercel project env (or `wrangler secret put` for Cloudflare).

### Tempo Environments

`TEMPO_ENV=moderato` uses Tempo testnet. Use it for local development, PR validation, and test payments with faucet-funded balances. No real funds are involved.

`TEMPO_ENV=tempo` uses Tempo mainnet. Use it only for production deployments where payments should settle with real USDC.e to your `PAYEE_ADDRESS`.

Keep local development on:

```bash
TEMPO_ENV=moderato
```

Switch production deployments to:

```bash
TEMPO_ENV=tempo
```
