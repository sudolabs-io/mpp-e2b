import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env.js";
import { atomicStoreFromRedis, resolveStore } from "../store.js";

afterEach(() => vi.restoreAllMocks());

/** Minimal Redis-like fake backed by a Map, honoring SET NX (the atomic primitive). */
function fakeRedis() {
	const map = new Map<string, unknown>();
	return {
		map,
		get: async (key: string) => (map.has(key) ? map.get(key) : null),
		set: async (key: string, value: unknown, opts?: { nx?: boolean; ex?: number }) => {
			if (opts?.nx && map.has(key)) return null; // key exists → claim fails
			map.set(key, value);
			return "OK";
		},
		del: async (key: string) => {
			map.delete(key);
			return 1;
		},
	};
}

// markHashUsed's exact callback: claim the key once, reject every reuse.
const markUsed = (current: unknown) =>
	current !== null
		? ({ op: "noop", result: false } as const)
		: ({ op: "set", value: 1, result: true } as const);

describe("atomicStoreFromRedis (replay protection)", () => {
	it("marks a payment hash used exactly once — a replay is rejected", async () => {
		const store = atomicStoreFromRedis(fakeRedis());
		const key = "mppx:charge:0xdeadbeef";

		expect(await store.update(key, markUsed)).toBe(true); // first use accepted
		expect(await store.update(key, markUsed)).toBe(false); // replay rejected
		expect(await store.update(key, markUsed)).toBe(false); // still rejected
	});

	it("rejects concurrent first-uses of the same hash (only one wins)", async () => {
		const store = atomicStoreFromRedis(fakeRedis());
		const key = "mppx:charge:0xrace";

		const results = await Promise.all([
			store.update(key, markUsed),
			store.update(key, markUsed),
			store.update(key, markUsed),
		]);

		expect(results.filter(Boolean)).toHaveLength(1); // exactly one true
	});

	it("releasing a hash lets it be claimed again (releaseHashUse path)", async () => {
		const store = atomicStoreFromRedis(fakeRedis());
		const key = "mppx:charge:0xreleased";

		expect(await store.update(key, markUsed)).toBe(true);
		await store.delete(key);
		expect(await store.update(key, markUsed)).toBe(true); // free again
	});
});

describe("resolveStore", () => {
	const base: Env = {
		TEMPO_ENV: "moderato",
		PAYEE_ADDRESS: "0x0000000000000000000000000000000000000001",
		MPPX_SECRET_KEY: "test-secret",
		E2B_API_KEY: "test-e2b-key",
	};

	it("warns and falls back to in-memory when Upstash is not configured", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const store = resolveStore(base);
		expect(store).toBeTruthy();
		expect(warn).toHaveBeenCalledOnce();
	});

	it("uses Upstash (no warning) when configured", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const store = resolveStore({
			...base,
			UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
			UPSTASH_REDIS_REST_TOKEN: "test-token",
		});
		expect(store).toBeTruthy();
		expect(warn).not.toHaveBeenCalled();
	});
});
