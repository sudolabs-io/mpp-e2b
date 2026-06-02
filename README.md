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
pnpm deploy
```

### Cloudflare Workers

Set secrets in `.dev.vars` for local development, or with `wrangler secret put` for deployments.

```bash
cp .dev.vars.example .dev.vars
pnpm dev:cf
pnpm deploy:cf
```

## Scripts

| Command | Target |
|---------|--------|
| `pnpm dev` | Alias for `pnpm dev:vercel` |
| `pnpm dev:vercel` | Run locally with Vercel Functions |
| `pnpm deploy` | Alias for `pnpm deploy:vercel` |
| `pnpm deploy:vercel` | Deploy to Vercel |
| `pnpm dev:cf` | Run locally with Cloudflare Workers |
| `pnpm deploy:cf` | Deploy to Cloudflare Workers |
| `pnpm check` | Run typecheck, lint, and tests |

## Secrets

| Variable | Description |
|----------|-------------|
| `E2B_API_KEY` | E2B API key from [e2b.dev/dashboard](https://e2b.dev/dashboard) |
| `MPPX_SECRET_KEY` | Secret key for mppx payment verification |
| `PAYEE_ADDRESS` | Wallet address to receive payments |
| `FEE_PAYER_PRIVATE_KEY` | Private key for gas sponsoring (optional) |
| `TEMPO_ENV` | `tempo` (mainnet) or `moderato` (testnet) |
