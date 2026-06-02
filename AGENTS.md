# mpp-e2b

Pay-per-use E2B sandbox proxy built with the [mppx SDK](https://github.com/wevm/mppx). Deploys to Vercel Functions and remains compatible with Cloudflare Workers.

## Architecture

- `src/index.ts` — Default Hono app export used by Vercel and Cloudflare + mppx Proxy delegation.
- `src/env.ts` — `Env` bindings type and runtime env adapter.
- `src/mppx.ts` — Payment method setup and `createMppx()` helper.
- `src/e2b.ts` — E2B service definition with pricing and payer isolation.
- `src/payer.ts` — Payer extraction and tagging utilities.

## Conventions

- Secrets go in Vercel env vars for the default deploy path, or `.dev.vars` / `wrangler secret put` for Cloudflare compatibility. Never commit secrets.
- Follow the mppx `custom()` service pattern from `mppx/proxy`.

## Testing

```bash
pnpm check # typecheck + lint + tests
pnpm test # vitest run
pnpm typecheck # tsc --noEmit
pnpm lint # biome check
```

## Deployment

```bash
pnpm dev # Vercel local dev
pnpm deploy # Vercel production deploy
pnpm dev:cf # Cloudflare local dev
pnpm deploy:cf # Cloudflare deploy
```
