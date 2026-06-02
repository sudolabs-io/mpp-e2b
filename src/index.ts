import { Hono } from "hono";
import { cors } from "hono/cors";
import { Proxy as MppxProxy } from "mppx/proxy";
import { createE2bService } from "./e2b.js";
import type { Env } from "./env.js";
import { envFromRuntime } from "./env.js";
import { createMppx } from "./mppx.js";
import { extractPayerAddress } from "./payer.js";

const app = new Hono<{ Bindings: Partial<Env> }>();

app.use("*", cors());

app.all("*", async (c) => {
	const requestUrl = new URL(c.req.url);
	if (isServicePrefixedE2bPath(requestUrl.pathname)) {
		return new Response("Not Found", { status: 404 });
	}

	const env = envFromRuntime(c.env);
	const mppx = createMppx(env);
	const service = createE2bService(env, mppx);

	const proxy = MppxProxy.create({
		title: "E2B MPP Proxy",
		description:
			"Pay-per-use E2B cloud sandboxes via the [Machine Payments Protocol](https://mpp.dev/llms.txt). Create, manage, and execute code in isolated cloud environments — pay with crypto.",
		services: [service],
	});

	const proxyReq = createProxyRequest(c.req.url, c.req.raw);
	proxyReq.headers.delete("x-payer-address");
	const payer = extractPayerAddress(c.req.raw);
	if (payer) proxyReq.headers.set("x-payer-address", payer);

	let res: Response;
	try {
		res = await proxy.fetch(proxyReq);
	} catch (e) {
		if (e instanceof TypeError && String(e.message).includes("null body status")) {
			res = new Response(null, { status: 204 });
		} else {
			throw e;
		}
	}

	if (isOpenApiPath(requestUrl.pathname)) {
		return stripServicePrefixFromOpenApi(res);
	}

	return res;
});

function isServicePrefixedE2bPath(pathname: string): boolean {
	return pathname === "/e2b" || pathname.startsWith("/e2b/");
}

function isOpenApiPath(pathname: string): boolean {
	return pathname === "/openapi.json" || pathname === "/openapi.json/";
}

async function stripServicePrefixFromOpenApi(response: Response): Promise<Response> {
	const contentType = response.headers.get("content-type");
	if (!response.ok || !contentType?.includes("application/json")) return response;

	const spec = (await response.json()) as { paths?: Record<string, unknown> };
	if (spec.paths) {
		spec.paths = Object.fromEntries(
			Object.entries(spec.paths).map(([path, value]) => [
				path.startsWith("/e2b/") ? path.slice("/e2b".length) : path,
				value,
			]),
		);
	}

	const headers = new Headers(response.headers);
	headers.delete("content-length");
	headers.set("content-type", "application/json");

	return new Response(JSON.stringify(spec), {
		headers,
		status: response.status,
		statusText: response.statusText,
	});
}

function createProxyRequest(url: string, request: Request): Request {
	const proxyUrl = new URL(url);

	if (shouldUseUnprefixedE2bPath(proxyUrl.pathname)) {
		proxyUrl.pathname = `/e2b${proxyUrl.pathname}`;
	}

	return new Request(proxyUrl.toString(), request);
}

function shouldUseUnprefixedE2bPath(pathname: string): boolean {
	return (
		pathname === "/sandboxes" ||
		pathname.startsWith("/sandboxes/") ||
		pathname.startsWith("/v2/sandboxes/")
	);
}

export default app;
