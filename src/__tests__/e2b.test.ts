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
