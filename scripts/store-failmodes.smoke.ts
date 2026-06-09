import { describe, expect, test } from "vitest";
import { mintCredential, type PayContext, send, trimTrailingSlash } from "./lib/credential.js";

/**
 * Replay-store failure-mode tests: the two architectural properties that justify backing
 * replay protection with Upstash rather than per-instance memory.
 *
 * These need server topology the other smoke tests don't (a second instance; an instance
 * whose Upstash is unreachable), so they are gated on env vars and skipped otherwise —
 * they will NOT run in a normal `pnpm smoke`. To exercise them, boot the instances and
 * point the vars at them:
 *
 *   # Cross-instance: two instances sharing one Upstash
 *   CROSS_BASE_URL_A=http://localhost:3001 CROSS_BASE_URL_B=http://localhost:3010 \
 *
 *   # Fail-closed: one instance whose UPSTASH_REDIS_REST_URL is unreachable
 *   DEAD_UPSTASH_BASE_URL=http://localhost:3011 \
 *     pnpm exec vitest run --config vitest.smoke.config.ts scripts/store-failmodes.smoke.ts
 */

const account = process.env.MPPX_ACCOUNT ?? "local-test";
const rpcUrl = process.env.MPPX_RPC_URL ?? "https://rpc.moderato.tempo.xyz";

const crossA = process.env.CROSS_BASE_URL_A;
const crossB = process.env.CROSS_BASE_URL_B;
const deadUpstash = process.env.DEAD_UPSTASH_BASE_URL;

describe("replay store failure modes", () => {
	// A credential spent on instance A must be rejected on instance B, proving the replay
	// store is shared across instances (the whole point of Upstash over in-memory).
	test.runIf(crossA && crossB)(
		"a credential spent on instance A is rejected on instance B",
		async () => {
			const a: PayContext = { baseUrl: trimTrailingSlash(crossA as string), account, rpcUrl };
			const b: PayContext = { baseUrl: trimTrailingSlash(crossB as string), account, rpcUrl };

			const auth = await mintCredential(a, "/sandboxes");

			const onA = await send(a, "/sandboxes", auth);
			expect(onA.status, `first use on A should 200, got ${onA.status}`).toBe(200);

			const onB = await send(b, "/sandboxes", auth);
			expect(onB.status, `replay on B should be rejected, got ${onB.status}`).toBe(402);
			expect(onB.body).toContain("already been used");
		},
	);

	// When the replay store is unreachable, the proxy must fail CLOSED — refuse the paid
	// request rather than serve it without replay protection (which would be a replay hole).
	test.runIf(deadUpstash)("paid request fails closed when the store is unreachable", async () => {
		const c: PayContext = { baseUrl: trimTrailingSlash(deadUpstash as string), account, rpcUrl };

		const auth = await mintCredential(c, "/sandboxes");
		const res = await send(c, "/sandboxes", auth);

		// The exact code is mppx's "payment verification failed" (402); the invariant under
		// test is simply that it did NOT serve the request.
		expect(res.status, `must not serve (got ${res.status})`).not.toBe(200);
		expect(res.status).toBe(402);
	});
});
