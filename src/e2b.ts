import { HTTPException } from "hono/http-exception";
import { custom, type Service } from "mppx/proxy";
import type { Env } from "./env.js";
import { jsonBody, type ServiceMppx } from "./mppx.js";
import { getPayer, payerTag } from "./payer.js";

const E2B_API_BASE = "https://api.e2b.dev";

/**
 * E2B sandbox compute pricing.
 *
 * E2B charges per-second based on vCPU and RAM. We price per-request with
 * amounts that approximate the cost for the sandbox lifetime.
 *
 * Reference: https://e2b.dev/pricing
 *   - vCPU: $0.000104/s → ~$0.031/5min
 *   - GiB RAM: $0.0000208/s → ~$0.006/5min
 *   - Default: 2 vCPU + 512 MiB ≈ $0.065/5min
 *
 * We add a 30% margin.
 */

/** Per-second rate for 1 vCPU */
const VCPU_RATE = 0.000104;
/** Per-second rate for 1 GiB RAM */
const GIB_RAM_RATE = 0.0000208;

/** E2B limits */
const MAX_TIMEOUT_S = 86400;
const MAX_CPU = 8;
const MAX_MEMORY_MB = 8192;

function positiveNumber(value: unknown, fallback: number, max: number): number {
	const n = typeof value === "number" ? value : fallback;
	if (!Number.isFinite(n) || n <= 0) {
		throw new HTTPException(400, { message: "Invalid numeric parameter" });
	}
	return Math.min(n, max);
}

function resolveCreatePrice(
	timeout: number,
	cpuCount?: number,
	memoryMB?: number,
): { amount: string; description: string } {
	const cpus = positiveNumber(cpuCount, 2, MAX_CPU);
	const memMB = positiveNumber(memoryMB, 512, MAX_MEMORY_MB);
	const memGiB = memMB / 1024;

	const cost = (cpus * VCPU_RATE + memGiB * GIB_RAM_RATE) * timeout;
	const withMargin = cost * 1.3;
	const amount = Math.max(withMargin, 0.001).toFixed(6);

	return {
		amount,
		description: `Create sandbox - ${cpus} vCPU, ${memMB.toFixed(0)} MiB, ${timeout}s`,
	};
}

/** Resolve pricing for extending a sandbox's TTL. */
function resolveExtendPrice(
	addedSeconds: number,
	cpuCount: number,
	memoryMB: number,
): { amount: string; description: string } {
	const memGiB = memoryMB / 1024;
	const cost = (cpuCount * VCPU_RATE + memGiB * GIB_RAM_RATE) * addedSeconds;
	const withMargin = cost * 1.3;
	const amount = Math.max(withMargin, 0.001).toFixed(6);

	return {
		amount,
		description: `Extend sandbox - ${addedSeconds}s`,
	};
}

/** Fetch sandbox details and verify the payer owns it. Returns sandbox spec. */
async function assertSandboxOwned(
	apiKey: string,
	sandboxId: string,
	payer: string,
): Promise<{ cpuCount: number; memoryMB: number }> {
	const res = await fetch(`${E2B_API_BASE}/sandboxes/${sandboxId}`, {
		headers: { "X-API-Key": apiKey },
	});
	if (!res.ok) throw new HTTPException(404, { message: "Sandbox not found" });

	const data = (await res.json()) as {
		metadata?: Record<string, string>;
		cpuCount?: number;
		memoryMB?: number;
	};

	if (data.metadata?.["mpp-payer"] !== payerTag(payer)) {
		throw new HTTPException(404, { message: "Sandbox not found" });
	}

	return { cpuCount: data.cpuCount ?? 2, memoryMB: data.memoryMB ?? 512 };
}

export function createE2bService(env: Env, mppx: ServiceMppx): Service.Service {
	const apiKey = env.E2B_API_KEY;

	const createHandler: Service.IntentHandler = async (req: Request) => {
		const body = await jsonBody<{
			timeout?: number;
			templateID?: string;
			cpuCount?: number;
			memoryMB?: number;
		}>(req);
		const timeout = positiveNumber(body.timeout, 300, MAX_TIMEOUT_S);
		const { amount, description } = resolveCreatePrice(timeout, body.cpuCount, body.memoryMB);
		return mppx.charge({ amount, description })(req);
	};

	/** Dynamic pricing for TTL refresh — charges based on sandbox spec × added time. */
	const refreshHandler: Service.IntentHandler = async (req: Request) => {
		const payer = getPayer(req);
		if (!payer) throw new HTTPException(402, { message: "Payment required" });
		const sandboxId = extractSandboxId(req.url);
		const spec = await assertSandboxOwned(apiKey, sandboxId, payer);
		const body = await jsonBody<{ duration?: number }>(req);
		const duration = positiveNumber(body.duration, 300, MAX_TIMEOUT_S);
		const { amount, description } = resolveExtendPrice(duration, spec.cpuCount, spec.memoryMB);
		return mppx.charge({ amount, description })(req);
	};

	/** Dynamic pricing for timeout set — charges based on sandbox spec × timeout. */
	const timeoutHandler: Service.IntentHandler = async (req: Request) => {
		const payer = getPayer(req);
		if (!payer) throw new HTTPException(402, { message: "Payment required" });
		const sandboxId = extractSandboxId(req.url);
		const spec = await assertSandboxOwned(apiKey, sandboxId, payer);
		const body = await jsonBody<{ timeout?: number }>(req);
		const timeout = positiveNumber(body.timeout, 300, MAX_TIMEOUT_S);
		const { amount, description } = resolveExtendPrice(timeout, spec.cpuCount, spec.memoryMB);
		return mppx.charge({ amount, description })(req);
	};

	const svc = custom("e2b", {
		baseUrl: E2B_API_BASE,
		title: "E2B",
		description:
			"Cloud sandboxes for AI agents — create, manage, and execute code in isolated environments. Pay per use with crypto.",
		docsLlmsUrl: () => "https://e2b.dev/docs/llms.txt",
		headers: {
			"X-API-Key": apiKey,
		},
		routes: {
			// --- Sandboxes ---
			"POST /sandboxes": createHandler,
			"GET /sandboxes": mppx.charge({ amount: "0.0001", description: "List sandboxes" }),
			"GET /sandboxes/:sandboxID": mppx.charge({
				amount: "0.0001",
				description: "Get sandbox",
			}),
			"DELETE /sandboxes/:sandboxID": mppx.charge({
				amount: "0.001",
				description: "Kill sandbox",
			}),

			// --- Sandbox lifecycle ---
			"POST /sandboxes/:sandboxID/connect": mppx.charge({
				amount: "0.01",
				description: "Connect to sandbox (resume if paused)",
			}),
			"POST /sandboxes/:sandboxID/pause": mppx.charge({
				amount: "0.001",
				description: "Pause sandbox",
			}),
			"POST /sandboxes/:sandboxID/refreshes": refreshHandler,
			"POST /sandboxes/:sandboxID/timeout": timeoutHandler,

			// --- Snapshots ---
			"POST /sandboxes/:sandboxID/snapshots": mppx.charge({
				amount: "0.01",
				description: "Create snapshot from sandbox",
			}),

			// --- Observability (nominal charge for authenticated access) ---
			"GET /sandboxes/:sandboxID/logs": mppx.charge({
				amount: "0.0001",
				description: "Get sandbox logs",
			}),
			"GET /v2/sandboxes/:sandboxID/logs": mppx.charge({
				amount: "0.0001",
				description: "Get sandbox logs",
			}),
			"GET /sandboxes/:sandboxID/metrics": mppx.charge({
				amount: "0.0001",
				description: "Get sandbox metrics",
			}),
		},
		rewriteRequest: async (req, ctx) => {
			const payer = getPayer(req);
			if (!payer) return req;

			const path = ctx.upstreamPath;

			// Tag created sandboxes with payer metadata for isolation
			if (req.method === "POST" && path === "/sandboxes") {
				const body = await jsonBody<{
					metadata?: Record<string, string>;
					[k: string]: unknown;
				}>(req);
				body.metadata = {
					...body.metadata,
					"mpp-payer": payerTag(payer),
				};
				return new Request(req.url, {
					method: req.method,
					headers: req.headers,
					body: JSON.stringify(body),
				});
			}

			// List: filter by payer metadata (overwrite, don't merge)
			if (req.method === "GET" && path === "/sandboxes") {
				const url = new URL(req.url);
				url.searchParams.set("metadata", `mpp-payer=${encodeURIComponent(payerTag(payer))}`);
				return new Request(url.toString(), {
					method: req.method,
					headers: req.headers,
				});
			}

			// Enforce ownership on all sandbox-scoped routes
			const sandboxId = sandboxIdFromPath(path);
			if (sandboxId) {
				await assertSandboxOwned(apiKey, sandboxId, payer);
			}

			return req;
		},
	});

	return svc;
}

/** Extract sandbox ID from the request URL path. */
function extractSandboxId(url: string): string {
	const path = new URL(url).pathname;
	const sandboxId = sandboxIdFromPath(path);
	if (!sandboxId) throw new HTTPException(400, { message: "Missing sandbox ID" });
	return sandboxId;
}

function sandboxIdFromPath(path: string): string | null {
	return path.match(/^\/(?:v2\/)?sandboxes\/([^/]+)/)?.[1] ?? null;
}
