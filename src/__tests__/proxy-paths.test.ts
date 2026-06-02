import { describe, expect, it } from "vitest";
import {
	createProxyRequest,
	isOpenApiPath,
	isServicePrefixedE2bPath,
	shouldUseUnprefixedE2bPath,
	stripServicePrefixFromOpenApi,
} from "../proxy-paths.js";

describe("isServicePrefixedE2bPath", () => {
	it.each([
		["/e2b", true],
		["/e2b/", true],
		["/e2b/sandboxes", true],
		["/sandboxes", false],
		["/openapi.json", false],
	])("returns %s for %s", (pathname, expected) => {
		expect(isServicePrefixedE2bPath(pathname)).toBe(expected);
	});
});

describe("isOpenApiPath", () => {
	it.each([
		["/openapi.json", true],
		["/openapi.json/", true],
		["/sandboxes", false],
	])("returns %s for %s", (pathname, expected) => {
		expect(isOpenApiPath(pathname)).toBe(expected);
	});
});

describe("shouldUseUnprefixedE2bPath", () => {
	it.each([
		["/sandboxes", true],
		["/sandboxes/abc", true],
		["/v2/sandboxes/abc/logs", true],
		["/e2b/sandboxes", false],
		["/openapi.json", false],
	])("returns %s for %s", (pathname, expected) => {
		expect(shouldUseUnprefixedE2bPath(pathname)).toBe(expected);
	});
});

describe("createProxyRequest", () => {
	it("prefixes sandbox routes with /e2b", () => {
		const req = createProxyRequest(
			"https://proxy.test/sandboxes",
			new Request("https://proxy.test/sandboxes", { method: "GET" }),
		);
		expect(new URL(req.url).pathname).toBe("/e2b/sandboxes");
	});

	it("leaves unrelated paths unchanged", () => {
		const req = createProxyRequest(
			"https://proxy.test/openapi.json",
			new Request("https://proxy.test/openapi.json", { method: "GET" }),
		);
		expect(new URL(req.url).pathname).toBe("/openapi.json");
	});
});

describe("stripServicePrefixFromOpenApi", () => {
	it("strips /e2b from path keys in the spec", async () => {
		const response = new Response(
			JSON.stringify({
				paths: {
					"/e2b/sandboxes": { get: {} },
					"/health": { get: {} },
				},
			}),
			{ headers: { "content-type": "application/json" }, status: 200 },
		);

		const stripped = await stripServicePrefixFromOpenApi(response);
		const spec = (await stripped.json()) as { paths: Record<string, unknown> };

		expect(spec.paths).toEqual({
			"/sandboxes": { get: {} },
			"/health": { get: {} },
		});
	});

	it("returns non-json responses unchanged", async () => {
		const response = new Response("not json", { status: 200 });
		expect(await stripServicePrefixFromOpenApi(response)).toBe(response);
	});
});
