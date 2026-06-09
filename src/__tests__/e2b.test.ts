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

	function mockTemplates(list: unknown[]) {
		return vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify(list), {
				headers: { "content-type": "application/json" },
				status: 200,
			}),
		);
	}

	function createSandbox(service: Service.Service, body: Record<string, unknown>) {
		return routeHandler(
			service,
			"POST /sandboxes",
		)(
			new Request("https://proxy.test/sandboxes", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
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

	it("rejects a non-owner's /timeout before charging", async () => {
		// The sandbox exists but belongs to a different payer; the caller (x-payer-address,
		// i.e. the paid request) must be rejected before mppx.charge runs — not billed-then-404'd.
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					cpuCount: 2,
					memoryMB: 512,
					metadata: { "mpp-payer": payerTag("0xowner") },
				}),
				{ headers: { "content-type": "application/json" }, status: 200 },
			),
		);
		const { build, calls } = recordingCharge();
		const service = build(env);

		await expect(
			routeHandler(
				service,
				"POST /sandboxes/:sandboxID/timeout",
			)(
				new Request("https://proxy.test/sandboxes/sb_123/timeout", {
					method: "POST",
					headers: { "x-payer-address": "0xattacker", "content-type": "application/json" },
					body: JSON.stringify({ timeout: 300 }),
				}),
			),
		).rejects.toThrow("Sandbox not found");
		expect(calls).toEqual([]); // not charged
	});

	it("rejects missing sandboxes before charging", async () => {
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
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ timeout: 300 }),
				}),
			),
		).rejects.toThrow("Sandbox not found");

		expect(calls).toEqual([]);
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

	it("prices create from the template's real spec", async () => {
		const fetchMock = mockTemplates([{ templateID: "tpl_big", cpuCount: 4, memoryMB: 4096 }]);
		const { build, calls } = recordingCharge();
		const service = build(env);

		await createSandbox(service, { templateID: "tpl_big", timeout: 600 });

		expect(fetchMock).toHaveBeenCalledWith("https://api.e2b.dev/templates", {
			headers: { "X-API-Key": env.E2B_API_KEY },
		});
		// 4 vCPU + 4 GiB over 600s with 30% margin
		expect(calls).toEqual([
			{ amount: "0.389376", description: "Create sandbox - 4 vCPU, 4096 MiB, 600s" },
		]);
	});

	it("does not trust client-supplied specs in the create body", async () => {
		// The request body is attacker-controlled: a caller can send any cpuCount/memoryMB
		// even though E2B ignores them and fixes resources at the template. Pricing must come
		// from the template spec, never the body — otherwise a caller could forge a cheap price.
		mockTemplates([{ templateID: "tpl_base", cpuCount: 2, memoryMB: 512 }]);
		const { build, calls } = recordingCharge();
		const service = build(env);

		await createSandbox(service, {
			templateID: "tpl_base",
			cpuCount: 1,
			memoryMB: 128,
			timeout: 600,
		});

		// Priced from the template (2/512), not the inflated-cheap body (1/128).
		expect(calls).toEqual([
			{ amount: "0.170352", description: "Create sandbox - 2 vCPU, 512 MiB, 600s" },
		]);
	});

	it("rejects templates without a top-level pricing spec", async () => {
		mockTemplates([
			{
				templateID: "tpl_b",
			},
		]);
		const { build, calls } = recordingCharge();
		const service = build(env);

		await expect(createSandbox(service, { templateID: "tpl_b", timeout: 300 })).rejects.toThrow(
			"Template spec unavailable",
		);

		expect(calls).toEqual([]);
	});

	it("rejects an unknown templateID before charging", async () => {
		mockTemplates([{ templateID: "tpl_other", cpuCount: 8, memoryMB: 8192 }]);
		const { build, calls } = recordingCharge();
		const service = build(env);

		await expect(createSandbox(service, { templateID: "ghost", timeout: 600 })).rejects.toThrow(
			'Unknown templateID "ghost"',
		);

		expect(calls).toEqual([]);
	});

	it("rejects a create with no templateID before charging", async () => {
		// E2B requires a templateID, so we reject up front rather than charge for a
		// create that would 400 upstream.
		const fetchMock = vi.spyOn(globalThis, "fetch");
		const { build, calls } = recordingCharge();
		const service = build(env);

		await expect(createSandbox(service, { timeout: 600 })).rejects.toThrow(
			"templateID is required",
		);

		expect(calls).toEqual([]);
		expect(fetchMock).not.toHaveBeenCalled(); // no template lookup needed
	});

	it("rejects a malformed timeout before charging", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch");
		const { build, calls } = recordingCharge();
		const service = build(env);

		await expect(createSandbox(service, { templateID: "base", timeout: "abc" })).rejects.toThrow(
			"Invalid numeric parameter",
		);

		expect(calls).toEqual([]); // not charged
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("rejects a non-owner's DELETE before charging (static route)", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ metadata: { "mpp-payer": payerTag("0xowner") } }), {
				headers: { "content-type": "application/json" },
				status: 200,
			}),
		);
		// Record charges at invocation time — chargeOwned binds mppx.charge at construction.
		const charged: string[] = [];
		const recMppx: ServiceMppx = {
			charge:
				({ description }) =>
				async () => {
					charged.push(description);
					return { challenge: new Response(null, { status: 402 }), status: 402 };
				},
		};
		const service = createE2bService(env, recMppx);

		await expect(
			routeHandler(
				service,
				"DELETE /sandboxes/:sandboxID",
			)(
				new Request("https://proxy.test/sandboxes/sb_123", {
					method: "DELETE",
					headers: { "x-payer-address": "0xattacker" },
				}),
			),
		).rejects.toThrow("Sandbox not found");
		expect(charged).toEqual([]); // charge handler never invoked
	});

	it("prices a public template statically without a template lookup", async () => {
		// Public templates aren't in GET /templates; their specs come from the pinned
		// allowlist (base = 2/512), so no lookup happens.
		const fetchMock = vi.spyOn(globalThis, "fetch");
		const { build, calls } = recordingCharge();
		const service = build(env);

		await createSandbox(service, { templateID: "base", timeout: 600 });

		expect(fetchMock).not.toHaveBeenCalled();
		expect(calls).toEqual([
			{ amount: "0.170352", description: "Create sandbox - 2 vCPU, 512 MiB, 600s" },
		]);
	});

	it("prices public templates by alias and by raw templateID", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch");
		const { build, calls } = recordingCharge();
		const service = build(env);

		// opencode alias → 2 vCPU / 2048 MiB
		await createSandbox(service, { templateID: "opencode", timeout: 600 });
		// claude alias → 4 vCPU / 8192 MiB
		await createSandbox(service, { templateID: "claude-code", timeout: 600 });
		// raw templateID for desktop → 8 vCPU / 8192 MiB
		await createSandbox(service, { templateID: "k0wmnzir0zuzye6dndlw", timeout: 600 });

		expect(fetchMock).not.toHaveBeenCalled();
		expect(calls).toEqual([
			{ amount: "0.194688", description: "Create sandbox - 2 vCPU, 2048 MiB, 600s" },
			{ amount: "0.454272", description: "Create sandbox - 4 vCPU, 8192 MiB, 600s" },
			{ amount: "0.778752", description: "Create sandbox - 8 vCPU, 8192 MiB, 600s" },
		]);
	});

	it("resolves a template by its alias", async () => {
		mockTemplates([
			{
				templateID: "jzk29sq3bltm1c3ghdpx",
				aliases: ["project-harness"],
				cpuCount: 4,
				memoryMB: 2048,
			},
		]);
		const { build, calls } = recordingCharge();
		const service = build(env);

		await createSandbox(service, { templateID: "project-harness", timeout: 600 });

		// Priced from the aliased template (4/2048), proving alias matching works.
		expect(calls).toEqual([
			{ amount: "0.356928", description: "Create sandbox - 4 vCPU, 2048 MiB, 600s" },
		]);
	});
});
