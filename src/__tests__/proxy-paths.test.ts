import { describe, expect, it } from "vitest";
import {
	createProxyRequest,
	isOpenApiPath,
	isServicePrefixedE2bPath,
	shouldUseUnprefixedE2bPath,
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
