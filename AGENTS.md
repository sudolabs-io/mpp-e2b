# mpp-e2b

Pay-per-use E2B sandbox proxy built with the [mppx SDK](https://github.com/wevm/mppx). Deploys to Cloudflare Workers.

## Architecture

- `src/index.ts` — Hono app entry point + mppx Proxy delegation.
- `src/env.ts` — `Env` bindings type.
- `src/mppx.ts` — Payment method setup and `createMppx()` helper.
- `src/e2b.ts` — E2B service definition with pricing and payer isolation.
- `src/payer.ts` — Payer extraction and tagging utilities.

## Conventions

- Secrets go in `.dev.vars` (local) or `wrangler secret put` (deployed). Never commit secrets.
- Follow the mppx `custom()` service pattern from `mppx/proxy`.

## Testing

```bash
pnpm test        # vitest run
pnpm typecheck   # tsc --noEmit
pnpm lint        # biome check
```
