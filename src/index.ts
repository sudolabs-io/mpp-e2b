import { Hono } from "hono";
import { cors } from "hono/cors";
import { Proxy as MppxProxy } from "mppx/proxy";
import { createE2bService } from "./e2b.js";
import type { Env } from "./env.js";
import { createMppx } from "./mppx.js";
import { extractPayerAddress } from "./payer.js";

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors());

app.all("*", async (c) => {
	const mppx = createMppx(c.env);
	const service = createE2bService(c.env, mppx);

	const proxy = MppxProxy.create({
		title: "E2B MPP Proxy",
		description:
			"Pay-per-use E2B cloud sandboxes via the [Machine Payments Protocol](https://mpp.dev/llms.txt). Create, manage, and execute code in isolated cloud environments — pay with crypto.",
		services: [service],
	});

	// Inject payer address from Payment credential
	const proxyReq = new Request(c.req.url, c.req.raw);
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

	return res;
});

export default app;
