import { describe, expect, it } from "vitest";
import { createProxyRequest, isOpenApiPath, isServicePrefixedE2bPath } from "../proxy-paths.js";

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

describe("createProxyRequest", () => {
	const proxyPath = (path: string) =>
		new URL(
			createProxyRequest(`https://proxy.test${path}`, new Request(`https://proxy.test${path}`)).url,
		).pathname;

	it.each([
		["/sandboxes", "/e2b/sandboxes"],
		["/sandboxes/sb_123", "/e2b/sandboxes/sb_123"],
		["/v2/sandboxes/sb_123/logs", "/e2b/v2/sandboxes/sb_123/logs"],
		// Block-list, not allow-list: a path that's hardcoded nowhere still maps through.
		["/files/abc", "/e2b/files/abc"],
	])("prefixes %s -> %s", (input, expected) => {
		expect(proxyPath(input)).toBe(expected);
	});

	it.each([
		["/"],
		["/openapi.json"],
		["/llms.txt"],
		["/e2b/sandboxes"],
	])("leaves root/discovery/already-prefixed path %s unchanged", (input) => {
		expect(proxyPath(input)).toBe(input);
	});
});
