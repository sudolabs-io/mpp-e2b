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
| `pnpm run smoke:prod -- --create` | Smoke test production Vercel with paid sandbox create/delete |

## Secrets

| Variable | Description |
|----------|-------------|
| `E2B_API_KEY` | E2B API key from [e2b.dev/dashboard](https://e2b.dev/dashboard) |
| `MPPX_SECRET_KEY` | Secret key for mppx payment verification |
| `PAYEE_ADDRESS` | Wallet address to receive payments |
| `FEE_PAYER_PRIVATE_KEY` | Private key for gas sponsoring (optional) |
| `TEMPO_ENV` | `tempo` (mainnet) or `moderato` (testnet) |

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
