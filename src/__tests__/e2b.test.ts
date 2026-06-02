import type { Service } from "mppx/proxy";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createE2bService } from "../e2b.js";
import type { Env } from "../env.js";
import type { ServiceMppx } from "../mppx.js";
import { payerTag } from "../payer.js";

const env: Env = {
	TEMPO_ENV: "moderato",
	PAYEE_ADDRESS: "0x0000000000000000000000000000000000000001",
	MPPX_SECRET_KEY: "test-secret",
	E2B_API_KEY: "test-e2b-key",
};

const mppx: ServiceMppx = {
	charge: () => async () => ({
		challenge: new Response(null, { status: 402 }),
		status: 402,
	}),
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe("createE2bService", () => {
	it("checks ownership for v2 sandbox-scoped routes", async () => {
		const payer = "0xabc123";
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					metadata: { "mpp-payer": payerTag(payer) },
					cpuCount: 2,
					memoryMB: 512,
				}),
				{ headers: { "content-type": "application/json" }, status: 200 },
			),
		);
		const service = createE2bService(env, mppx);
		const request = new Request("https://proxy.test/v2/sandboxes/sb_123/logs", {
			headers: { "x-payer-address": payer },
		});

		await expect(
			service.rewriteRequest?.(request, {
				request,
				service,
				upstreamPath: "/v2/sandboxes/sb_123/logs",
			}),
		).resolves.toBe(request);

		expect(fetchMock).toHaveBeenCalledWith("https://api.e2b.dev/sandboxes/sb_123", {
			headers: { "X-API-Key": env.E2B_API_KEY },
		});
	});

	it("rejects v2 sandbox-scoped routes owned by another payer", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ metadata: { "mpp-payer": payerTag("0xother") } }), {
				headers: { "content-type": "application/json" },
				status: 200,
			}),
		);
		const service = createE2bService(env, mppx);
		const request = new Request("https://proxy.test/v2/sandboxes/sb_123/logs", {
			headers: { "x-payer-address": "0xabc123" },
		});

		await expect(
			service.rewriteRequest?.(request, {
				request,
				service,
				upstreamPath: "/v2/sandboxes/sb_123/logs",
			}),
		).rejects.toThrow("Sandbox not found");
	});
});

describe("createE2bService dynamic pricing", () => {
	/** Capture the amount/description passed to mppx.charge for assertions. */
	function recordingCharge() {
		const calls: { amount: string; description: string }[] = [];
		const mppx: ServiceMppx = {
			charge: (params) => {
				calls.push(params);
				return async () => ({ challenge: new Response(null, { status: 402 }), status: 402 });
			},
		};
		// Static routes call charge() at construction time; only handler-time calls matter here.
		const build = (env: Env) => {
			const service = createE2bService(env, mppx);
			calls.length = 0;
			return service;
		};
		return { build, calls };
	}

	function routeHandler(service: Service.Service, route: string): Service.IntentHandler {
		const endpoint = service.routes[route];
		if (typeof endpoint !== "function") throw new Error(`Route ${route} is not an IntentHandler`);
		return endpoint;
	}

	function mockSandbox(spec: { cpuCount: number; memoryMB: number }) {
		return vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify(spec), {
				headers: { "content-type": "application/json" },
				status: 200,
			}),
		);
	}

	it("prices /timeout from the real sandbox spec", async () => {
		const fetchMock = mockSandbox({ cpuCount: 4, memoryMB: 2048 });
		const { build, calls } = recordingCharge();
		const service = build(env);

		await routeHandler(
			service,
			"POST /sandboxes/:sandboxID/timeout",
		)(
			new Request("https://proxy.test/sandboxes/sb_123/timeout", {
				method: "POST",
				headers: { authorization: "Bearer paid", "content-type": "application/json" },
				body: JSON.stringify({ timeout: 300 }),
			}),
		);

		expect(fetchMock).toHaveBeenCalledWith("https://api.e2b.dev/sandboxes/sb_123", {
			headers: { "X-API-Key": env.E2B_API_KEY },
		});
		// 4 vCPU + 2 GiB over 300s with 30% margin
		expect(calls).toEqual([{ amount: "0.178464", description: "Extend sandbox - 300s" }]);
	});

	it("prices /refreshes from the real sandbox spec", async () => {
		mockSandbox({ cpuCount: 8, memoryMB: 4096 });
		const { build, calls } = recordingCharge();
		const service = build(env);

		await routeHandler(
			service,
			"POST /sandboxes/:sandboxID/refreshes",
		)(
			new Request("https://proxy.test/sandboxes/sb_123/refreshes", {
				method: "POST",
				headers: { authorization: "Bearer paid", "content-type": "application/json" },
				body: JSON.stringify({ duration: 600 }),
			}),
		);

		// 8 vCPU + 4 GiB over 600s with 30% margin
		expect(calls).toEqual([{ amount: "0.713856", description: "Extend sandbox - 600s" }]);
	});

	it("falls back to the default spec for an unpaid challenge", async () => {
		// Sandbox lookup fails and the request carries no payment authorization.
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }));
		const { build, calls } = recordingCharge();
		const service = build(env);

		await routeHandler(
			service,
			"POST /sandboxes/:sandboxID/timeout",
		)(
			new Request("https://proxy.test/sandboxes/sb_123/timeout", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ timeout: 300 }),
			}),
		);

		// Default 2 vCPU + 512 MiB over 300s with 30% margin
		expect(calls).toEqual([{ amount: "0.085176", description: "Extend sandbox - 300s" }]);
	});

	it("rejects a paid request for a missing sandbox", async () => {
		// Lookup fails but the request is authenticated, so we must not invent a spec.
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }));
		const { build, calls } = recordingCharge();
		const service = build(env);

		await expect(
			routeHandler(
				service,
				"POST /sandboxes/:sandboxID/timeout",
			)(
				new Request("https://proxy.test/sandboxes/sb_123/timeout", {
					method: "POST",
					headers: { authorization: "Bearer paid", "content-type": "application/json" },
					body: JSON.stringify({ timeout: 300 }),
				}),
			),
		).rejects.toThrow("Sandbox not found");
		expect(calls).toEqual([]);
	});
});
