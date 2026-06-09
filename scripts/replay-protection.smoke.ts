import { describe, expect, test } from "vitest";
import { mintCredential, type PayContext, send, trimTrailingSlash } from "./lib/credential.js";

/**
 * Replay-protection adversarial smoke tests.
 *
 * The happy-path smoke suite mints a *fresh* payment per request, so its credentials are
 * always unique and the replay-rejection path never fires. These tests do the opposite:
 * they mint ONE credential with `mppx sign` and re-send it, exercising the shared replay
 * store (Upstash in prod, in-memory in dev) that the proxy uses to enforce "a payment
 * credential is usable exactly once".
 *
 * The concurrent-race test is the only test that actually exercises the bounded
 * read-modify-claim loop in `src/store.ts`: a single-threaded replay would pass even on
 * the in-memory fallback, but N simultaneous replays only resolve to "exactly one wins"
 * if the SET-if-absent claim is atomic.
 *
 * Requires a running server (SMOKE_BASE_URL) and a funded mppx account, like the other
 * smoke tests. Run via `pnpm smoke:local -- --base-url http://localhost:PORT`.
 */

const ctx: PayContext = {
	baseUrl: trimTrailingSlash(process.env.SMOKE_BASE_URL ?? "http://localhost:3000"),
	account: process.env.MPPX_ACCOUNT ?? "local-test",
	rpcUrl: process.env.MPPX_RPC_URL ?? "https://rpc.moderato.tempo.xyz",
};
// How many simultaneous replays to fire in the race. Each losing request is cheap (no
// payment settles), so a modest fan-out is enough to expose a non-atomic claim.
const raceCount = Number(process.env.REPLAY_RACE_N ?? 8);

console.log(`Replay-protection smoke testing ${ctx.baseUrl}`);
console.log(`mppx account: ${ctx.account}`);

describe("replay protection", () => {
	test("a replayed credential is rejected (sequential)", async () => {
		const auth = await mintCredential(ctx, "/sandboxes");

		const first = await send(ctx, "/sandboxes", auth);
		expect(first.status, `first use should succeed, got ${first.status}: ${first.body}`).toBe(200);

		const second = await send(ctx, "/sandboxes", auth);
		expect(second.status, `replay should be rejected, got ${second.status}`).toBe(402);
		expect(second.body).toContain("already been used");

		// A third replay must still be rejected (the marker is durable, not consumed-on-read).
		const third = await send(ctx, "/sandboxes", auth);
		expect(third.status).toBe(402);
	});

	test(`concurrent replays: exactly one of ${raceCount} wins`, async () => {
		const auth = await mintCredential(ctx, "/sandboxes");

		// Fire all replays as concurrently as the event loop allows — they should all reach
		// the store's claim within the same window, maximising contention on SET NX.
		const results = await Promise.all(
			Array.from({ length: raceCount }, () => send(ctx, "/sandboxes", auth)),
		);

		const statuses = results.map((r) => r.status);
		const winners = statuses.filter((s) => s === 200).length;
		const rejected = statuses.filter((s) => s === 402).length;

		expect(
			winners,
			`expected exactly 1 winner out of ${raceCount}, got ${winners}. statuses=${statuses.join(",")}`,
		).toBe(1);
		expect(
			rejected,
			`expected ${raceCount - 1} rejections, got ${rejected}. statuses=${statuses.join(",")}`,
		).toBe(raceCount - 1);

		// Every loser must be a replay rejection specifically, not some other error.
		for (const r of results.filter((r) => r.status === 402)) {
			expect(r.body).toContain("already been used");
		}
	});
});
