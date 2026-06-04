import { describe, expect, it } from "vitest";
import { createE2bService } from "../e2b.js";
import type { Env } from "../env.js";
import type { ServiceMppx } from "../mppx.js";
import { buildE2bOpenApi } from "../openapi.js";

const env: Env = {
	TEMPO_ENV: "moderato",
	PAYEE_ADDRESS: "0x0000000000000000000000000000000000000001",
	MPPX_SECRET_KEY: "test-secret",
	E2B_API_KEY: "test-e2b-key",
};

// Mock that mirrors mppx.charge: the returned handler carries the `_internal`
// payment metadata that Service.paymentOf reads to build x-payment-info.
const mppx: ServiceMppx = {
	charge: ({ amount, description }) => {
		const handler = async () => ({
			challenge: new Response(null, { status: 402 }),
			status: 402 as const,
		});
		Object.assign(handler, {
			_internal: {
				name: "tempo",
				intent: "charge",
				amount,
				decimals: 6,
				currency: "0xcurrency",
				recipient: "0xpayee",
				description,
			},
		});
		return handler;
	},
};

// biome-ignore lint/suspicious/noExplicitAny: terse access into a generated OpenAPI doc
function buildDoc(): any {
	return buildE2bOpenApi(createE2bService(env, mppx), { title: "E2B MPP Proxy" });
}

const DYNAMIC_POST_ROUTES = [
	"/sandboxes",
	"/sandboxes/:sandboxID/timeout",
	"/sandboxes/:sandboxID/refreshes",
];

describe("buildE2bOpenApi", () => {
	it("emits public, unprefixed paths only", () => {
		const paths = Object.keys(buildDoc().paths);
		expect(paths).toContain("/sandboxes");
		expect(paths.some((p: string) => p.startsWith("/e2b"))).toBe(false);
	});

	it("derives x-payment-info and 402 for flat-priced routes", () => {
		const op = buildDoc().paths["/sandboxes"].get;
		expect(op["x-payment-info"].amount).toBe("100"); // 0.0001 * 1e6
		expect(op["x-payment-info"].method).toBe("tempo");
		expect(op.responses["402"]).toBeDefined();
	});

	it("keeps the flat price on ownership-wrapped routes (metadata preserved)", () => {
		const op = buildDoc().paths["/sandboxes/:sandboxID"].delete;
		expect(op["x-payment-info"].amount).toBe("1000"); // 0.001 * 1e6 — survives chargeOwned wrap
		expect(op.responses["402"]).toBeDefined();
	});

	it("documents create with a required templateID and without per-request cpu/ram", () => {
		const op = buildDoc().paths["/sandboxes"].post;
		const schema = op.requestBody.content["application/json"].schema;
		expect(op.requestBody.required).toBe(true);
		expect(schema.required).toEqual(["templateID"]);
		expect(Object.keys(schema.properties)).toContain("templateID");
		expect(Object.keys(schema.properties)).not.toContain("cpuCount");
		expect(Object.keys(schema.properties)).not.toContain("memoryMB");
	});

	it("advertises dynamically-priced routes as paid with a null amount", () => {
		const doc = buildDoc();
		for (const path of DYNAMIC_POST_ROUTES) {
			const op = doc.paths[path].post;
			expect(op["x-payment-info"], path).toBeDefined();
			expect(op["x-payment-info"].amount, path).toBeNull();
			expect(op["x-payment-info"].currency, path).toBe("0xcurrency"); // cloned from flat route
			expect(op.responses["402"], path).toBeDefined();
		}
	});

	it("documents the timeout/duration bodies for the extend routes", () => {
		const doc = buildDoc();
		const timeoutSchema =
			doc.paths["/sandboxes/:sandboxID/timeout"].post.requestBody.content["application/json"]
				.schema;
		const refreshSchema =
			doc.paths["/sandboxes/:sandboxID/refreshes"].post.requestBody.content["application/json"]
				.schema;
		expect(timeoutSchema.required).toEqual(["timeout"]);
		expect(refreshSchema.required).toEqual(["duration"]);
	});
});
