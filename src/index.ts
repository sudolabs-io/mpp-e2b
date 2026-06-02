import { Hono } from "hono";
import { cors } from "hono/cors";
import { Proxy as MppxProxy } from "mppx/proxy";
import { createE2bService } from "./e2b.js";
import type { Env } from "./env.js";
import { envFromRuntime } from "./env.js";
import { createMppx } from "./mppx.js";
import { buildE2bOpenApi } from "./openapi.js";
import { extractPayerAddress } from "./payer.js";
import { createProxyRequest, isOpenApiPath, isServicePrefixedE2bPath } from "./proxy-paths.js";

const PROXY_TITLE = "E2B MPP Proxy";
const PROXY_DESCRIPTION =
	"Pay-per-use E2B cloud sandboxes via the [Machine Payments Protocol](https://mpp.dev/llms.txt). Create, manage, and execute code in isolated cloud environments — pay with crypto.";

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

	// Serve our own discovery document, generated from the service's own routes,
	// so request bodies and dynamic-pricing payment info are accurate. mppx's
	// auto-generated /openapi.json omits both for custom-handler routes.
	if (isOpenApiPath(requestUrl.pathname)) {
		return Response.json(buildE2bOpenApi(service, { title: PROXY_TITLE }));
	}

	const proxy = MppxProxy.create({
		title: PROXY_TITLE,
		description: PROXY_DESCRIPTION,
		services: [service],
	});

	const proxyReq = createProxyRequest(c.req.url, c.req.raw);
	proxyReq.headers.delete("x-payer-address");
	const payer = extractPayerAddress(c.req.raw);
	if (payer) proxyReq.headers.set("x-payer-address", payer);

	try {
		return proxy.fetch(proxyReq);
	} catch (e) {
		if (e instanceof TypeError && String(e.message).includes("null body status")) {
			return new Response(null, { status: 204 });
		}
		throw e;
	}
});

export default app;
