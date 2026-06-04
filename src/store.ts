import { Redis } from "@upstash/redis";
import { Store } from "mppx/server";
import type { Env } from "./env.js";

/**
 * Replay-protection store.
 *
 * mppx records each consumed payment hash/proof in an {@link Store.AtomicStore} so a
 * credential can't be replayed. That store MUST be shared across requests/instances —
 * an in-memory one (the mppx default) is wiped every request on serverless and gives
 * no real protection. We back it with Upstash Redis, which works on both Cloudflare
 * Workers and Vercel.
 *
 * mppx's built-in adapters are only atomic if the client supplies an `update`, and the
 * Upstash client doesn't — so we provide one. Replay marking is a set-if-absent, which
 * maps to `SET … NX`; a short TTL (well beyond the ~5-min challenge expiry) keeps the
 * keyspace bounded without ever permitting a replay (expired credentials are rejected
 * by mppx before the store is consulted).
 */
const MARKER_TTL_SECONDS = 3600;

type RedisLike = {
	get: (key: string) => Promise<unknown>;
	set: (key: string, value: unknown, opts?: { nx: true; ex: number }) => Promise<unknown>;
	del: (key: string) => Promise<unknown>;
};

/** Build an atomic mppx store from a Redis-like client. Exported for tests. */
export function atomicStoreFromRedis(redis: RedisLike): Store.AtomicStore {
	return Store.upstash({
		get: (key: string) => redis.get(key),
		set: (key: string, value: unknown) => redis.set(key, value),
		del: (key: string) => redis.del(key),
		// biome-ignore lint/suspicious/noExplicitAny: matches mppx's Update callback shape
		update: async (key: string, fn: (current: unknown) => any) => {
			// Bounded read-modify-claim. The only `set` we issue is set-if-absent (replay
			// markers), made atomic with SET NX. If we lose the claim race we re-read and
			// recompute — so a concurrent reuse resolves to fn's "already present" branch
			// (i.e. rejected), never to an unset `true`.
			for (let attempt = 0; attempt < 5; attempt++) {
				const current = (await redis.get(key)) ?? null;
				const change = fn(current);
				if (change.op === "delete") {
					await redis.del(key);
					return change.result;
				}
				if (change.op !== "set") {
					return change.result; // noop
				}
				if (current !== null) {
					// fn chose to set despite a present value — a deliberate overwrite, no NX.
					await redis.set(key, change.value);
					return change.result;
				}
				const claimed = await redis.set(key, change.value, { nx: true, ex: MARKER_TTL_SECONDS });
				if (claimed !== null) return change.result; // we won the claim
				// NX failed: another writer set it between our read and claim — retry.
			}
			// Extremely unlikely: keep recomputing churn from winning. Resolve as "present".
			return fn((await redis.get(key)) ?? null).result;
		},
	});
}

/**
 * Resolve the replay-protection store from the environment. Uses Upstash when
 * configured; otherwise falls back to an in-memory store with a loud warning (fine for
 * dev/tests, NOT safe in production — replay protection is then ineffective).
 */
export function resolveStore(env: Env): Store.AtomicStore {
	const url = env.UPSTASH_REDIS_REST_URL;
	const token = env.UPSTASH_REDIS_REST_TOKEN;
	if (!url || !token) {
		console.warn(
			"[mpp-e2b] UPSTASH_REDIS_REST_URL/TOKEN not set — using an in-memory replay store. " +
				"Replay protection is NOT effective across requests/instances; configure Upstash in production.",
		);
		return Store.memory();
	}
	return atomicStoreFromRedis(new Redis({ url, token }));
}
